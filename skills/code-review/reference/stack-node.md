# Node.js 后端 · 审查命令映射

> **状态**：源文本记载的实测环境为本机 node v22.23.1 与 v18.20.4（nvm 并存对比）、eslint 9.39.5、typescript 5.9.3、madge 8.0.0、fastify 5，带「实测」字样的结论来自这些；pm2 / docker / redis 未安装、Nest 未安装，相关命令按官方文档给出，**未实测**。事实核查的修正已并入正文。

## 四类动作

### 1. 语法  `[version-dependent]`

```bash
node --check src/app.js            # 仅 .js/.mjs/.cjs
npx tsc --noEmit -p tsconfig.json  # TS 的语法层与类型层一起查
```

- 版本依赖：实测同一份含 import 的 .js，v22.23.1 `node --check` exit 0（22.7+ 默认探测模块语法），v18.20.4 报 "Cannot use import statement outside a module"；`node --check t.ts` 在 22.23 也报错（加 --experimental-strip-types 照样报），TS 一律用 tsc。
- 若用 esbuild 查 TS 语法：glob 须由 shell 展开（不要加引号），`--outdir` 必须是真目录（`"$(mktemp -d)"`），否则会被误读成语法错；不如直接 tsc。
- 这条抓不到什么：类型错误、未定义名、运行时行为；node 版本不同结论可能相反。

### 2. 静态  `[confident]`

```bash
npx eslint . --max-warnings=0                 # 需 eslint.config.mjs：recommended + globals.node + sourceType 与真实模块体系一致
npx tsc --noEmit -p tsconfig.json             # tsconfig 需开 noUnusedLocals / noUnusedParameters，否则不报未用变量
```

- 实测 eslint 9.39.5 一次抓出未用 import、未用变量、未用形参、未定义名；tsc 5.9.3：TS2304 未定义名、TS6133 未用变量（关掉 noUnused* 后后者整类消失）。TS 项目要关 eslint 的 no-undef（交给 tsc）。tsc 只看 include 命中的文件，可用 `--listFiles | grep -F <改动文件>` 确认覆盖。
- 这条抓不到什么：运行时才暴露的问题（循环依赖半初始化、DI 装配、类型擦除后的行为）、逻辑错误。

### 3. 加载冒烟  `[confident]`

```bash
PORT=0 NODE_ENV=test node -e 'const m=require("./src/app.js"); if(typeof m.createApp!=="function"){console.error(Object.keys(m));process.exit(1)}; process.exit(0)'   # CJS：真调导出
npx madge --circular --extensions ts,js,mjs,cjs src                                                                                                                    # 静态查环，有环 exit 1（实测）
```

- ESM 入口：`PORT=0 node -e 'import("./src/app.js").then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})'`；Fastify 用 `await app.ready()` 走完插件树/路由注册且不 listen（实测）。
- 这条抓不到什么：CJS 循环依赖不会抛错，只有真调导出才暴露；不验证业务逻辑；顶层有副作用的入口会真连库/发请求。

### 4. 逻辑验证  `[version-dependent]`

```bash
node --test test/        # 内置 runner，node 20+ 稳定
```

- TS 测试 `--experimental-strip-types` 需 22.6+，enum 在 strip 模式下不支持。
- 这条抓不到什么：没被测试覆盖的路径；用与生产不同的引擎/mock 跑过不等于生产行为正确；`--permission` 不管网络，不能代表「没有外发请求」。

## 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- CJS/ESM 边界一致性：package.json 的 type 与 exports 字段、.mjs/.cjs 扩展名、ESM 里还在用 __dirname/require（应为 import.meta.dirname，Node 20.11+）、对 ESM-only 包用 require（Node 22.12 前抛 ERR_REQUIRE_ESM）
- async 错误路径：漏写的 await（浮空 promise 静默丢错）、Promise.all 一个 reject 拖垮整体、Express 4 里 async handler 抛错不进 error middleware（需 wrapper 或升 Express 5）、有没有 unhandledRejection 兜底（Node 15+ 默认让进程退出）
- 事件循环阻塞（Python 多 worker 下不明显、Node 单线程会拖垮整个进程）：readFileSync、大 body 的 JSON.parse、同步 crypto/zlib、可回溯爆炸的正则、循环里 await 串行化
- 类型边界的真实性：as / any / 非空断言把检查糊过去；req.body、process.env、第三方响应有没有运行时校验（zod/valibot）；tsconfig 的 strict / noUncheckedIndexedAccess 是否被关掉
- 资源与句柄泄漏（常驻进程会累积）：setInterval 没 clearInterval 也没 unref()、DB 连接池不关、stream/fs.watch 不销毁、EventEmitter MaxListeners 警告
- 停机与幂等：有没有 SIGTERM/SIGINT handler，handler 里是否 server.close() + closeIdleConnections() + 关连接池 + worker.close()；队列 handler 是否幂等（BullMQ 是 at-least-once，重启会重派）
- 依赖与产物一致性：lockfile 是否随 package.json 同提交、runtime 代码有没有 require 到 devDependency、dist 是否由本次 build 产生、engines.node/.nvmrc 与服务器 node -v 一致、native 模块是否需要 npm rebuild
- 副作用位置：模块顶层有没有连库/读文件/发请求/app.listen()/注册定时器；配置读取是否发生在 import 期（会让测试和冒烟被迫连生产）

## 本栈特有的坑

- **CJS 循环依赖「静默通过」** `[confident]`：实测 v22.23 a.cjs ↔ b.cjs 互 require 进程 exit 0，只打 Warning，拿到 undefined；同结构 ESM 直接 ReferenceError。审查时不能只信「require 成功」，要看有没有真调导出的断言，并建议 madge 查环。
- **`node --check` 的假安全感** `[confident]`：结论随 node 版本翻转（22.7+ 探测模块语法，18 报错），对 .ts 不可用。审查时见到「本地 --check 过了」当作弱证据，TS 以 tsc 为准。
- **TS 检查全绿 ≠ 运行时对** `[confident]`：strip-types 遇 enum 报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX（实测）；`import type` / verbatimModuleSyntax 下装饰器元数据被擦，Nest 构造函数注入会拿到 undefined 而 tsc 不报；`module: NodeNext` 下 package.json 少一行 `"type":"module"`，.ts 被当 CJS 报 TS1287（实测）。审查 TS 改动要看运行形态（build 产物 / 项目 loader），不只看 tsc。
- **顶层副作用让冒烟变成打生产** `[confident]`：入口顶层的 dotenv.config()、连接池、定时器、app.listen() 一句 require 就会触发；PORT=0 只解决端口冲突。审查时标出这类顶层副作用，建议拆 app / server 两层。
- **node 版本漂移** `[confident]`：实测 v18.20.4 与 v22.23.1 对同一批命令结论不同（node:sqlite、--permission、ESM 语法探测、require(esm) 到 22.12+）。审查结论里要注明依赖的最低 node 版本，并核对 .nvmrc / engines.node 与运行环境一致。
