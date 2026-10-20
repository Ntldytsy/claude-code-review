# Node.js 后端 · 命令映射

> **状态**：源文本记载的实测环境为本机 node v22.23.1 与 v18.20.4（nvm 并存对比）、eslint 9.39.5、typescript 5.9.3、madge 8.0.0、fastify 5，带「实测」字样的结论来自这些；pm2 / docker / redis 未安装、Nest 未安装，相关命令按官方文档给出，**未实测**。事实核查的修正已并入正文。

## Node.js 后端（CommonJS/ESM × 纯 JS/TypeScript × Express/Nest/Fastify）。实测环境：node v22.23.1 与 v18.20.4（nvm 并存对比）、eslint 9.39.5、typescript 5.9.3、madge 8.0.0、fastify 5；pm2/docker/redis 未在本机安装，相关命令按官方文档给出并已标注未实测。

### 四类动作的命令映射（审查用：语法 / 静态 / 加载冒烟 / 逻辑验证）

#### 1. 语法检查  `[version-dependent]`

```bash
# 纯 JS（.js/.mjs/.cjs）
node --check src/app.js
# 只查本次改动（macOS 的 xargs 没有 -r，去掉即可）
git diff --name-only --diff-filter=ACM HEAD | grep -E '\.(js|mjs|cjs)$' | xargs -r -n1 node --check
# 强制按 ESM 解析（不看 package.json；stdin 必须显式指定）
cat src/app.js | node --check --input-type=module

# TypeScript：node --check 不认类型注解，别用
npx tsc --noEmit -p tsconfig.json          # 语法+类型一起（见静态检查那条）
# 纯语法层（可选，tsc 更稳）：esbuild 不做 glob 展开，须让 shell 展开（bash 需 shopt -s globstar，zsh 原生支持），且 outdir 必须是真目录
npx esbuild src/**/*.ts --outdir="$(mktemp -d)"
# 或逐文件走 stdin：esbuild --loader=ts < f.ts > /dev/null
```

> 注：esbuild 不展开引号里的 glob（`'src/**/*.ts'` 会被当字面路径报 could not resolve），`--outdir=/dev/null` 会 ENOTDIR——两者都会被误读成「语法有问题」；`--loader:.ts=ts` 对 .ts 文件多余。纯语法层用 esbuild 不值得多这一层坑，直接用 tsc。

**说明**：实测分界线在 node 版本：同一份含 import 的 .js，v22.23.1 `node --check` exit 0（22.7+ 默认开模块语法探测），v18.20.4 直接报 "Cannot use import statement outside a module"。.mjs + 顶层 await 在 18/22 都通过。stdin 不走探测，必须 --input-type=module。`node --check t.ts` 在 22.23 报 SyntaxError: Missing initializer in const declaration，**加 --experimental-strip-types 也一样报** —— TS 的语法层只能靠 tsc/esbuild/swc。



#### 2. 静态检查  `[confident]`

##### 2a. ESLint（纯 JS 与 TS 项目的未用/未定义名）

```bash
npm i -D eslint@9 @eslint/js globals
cat > eslint.config.mjs <<'EOF'
import js from "@eslint/js";
import globals from "globals";
export default [
  js.configs.recommended,
  { files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",          // 纯 CJS 项目改成 "commonjs"
      globals: { ...globals.node }   // 不写这行，process/require/__dirname 会被 no-undef 误报
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-undef": "error",                                   // ≈ pyflakes F821
      "no-unused-vars": ["error", { args: "after-used", varsIgnorePattern: "^_", argsIgnorePattern: "^_" }], // ≈ F401/F841
      "no-redeclare": "error", "no-dupe-keys": "error",
      "no-unreachable": "error", "no-const-assign": "error",
      "require-atomic-updates": "error"
    } }
];
EOF
npx eslint . --max-warnings=0            # 有问题 exit 1

# TS 项目：按 typescript-eslint 官方建议关掉 no-undef（tsc 管未定义名），未用变量换插件版
npm i -D typescript-eslint
#   rules: { "no-undef": "off", "@typescript-eslint/no-unused-vars": ["error", {argsIgnorePattern:"^_"}] }
```

**说明**：实测 eslint 9.39.5 对一段 4 行代码一次抓出 4 条：未用 import(`'path' is defined but never used`)、未用变量、未用形参、未定义名(`'typoFunction' is not defined`)——正好覆盖 pyflakes 那层“改动过程中自己新引入的 bug”。三个必须做对的点：globals.node 不写就全是误报；sourceType 必须和真实模块体系一致（CJS 写成 module 会解析错 require）；TS 下开着 no-undef 会对类型名和全局误报，必须关。补一层 import 解析：`npm i -D eslint-plugin-import` 开 `import/no-unresolved` + `import/named`，能抓到 pyflakes 抓不到的“路径写错/命名导出不存在”。

##### 2b. tsc（类型 + 未定义名 + 未用变量）

```bash
npx tsc --noEmit -p tsconfig.json          # 有错 exit 2
# tsconfig 里这两项不开，tsc 不报未用变量：
#   "noUnusedLocals": true, "noUnusedParameters": true

# 关心哪几类错就 grep：TS2304 未定义名 / TS6133 未用 / TS2339 属性不存在 / TS7006 隐式 any
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'TS2304|TS6133|TS2339|TS7006'

# 确认你改的文件真的在检查范围内（不在 include 里会静默漏过）
npx tsc --noEmit -p tsconfig.json --listFiles | grep -F src/你改的文件.ts

# 纯 JS 项目也能白拿这一层，不用改成 .ts
npx tsc --noEmit --allowJs --checkJs --skipLibCheck --target ES2022 --module NodeNext src/*.js
```

**说明**：实测 tsc 5.9.3：TS2304 = "Cannot find name 'typoFn'"（未定义名），TS6133 = 未用变量/形参，但**关掉 noUnusedLocals/noUnusedParameters 后同一文件只剩 TS2304**，未用变量整类消失。tsc 在 Node 栈里的位置 = pyflakes + mypy 合体，是最能抓“改一半忘了改另一半”的一层，应该是 CI 的硬门禁（exit 2）。注意它只看 include 命中的文件，所以 --listFiles 那句值得写进流程。

#### 3. 加载冒烟  `[confident]`

##### 3a. 通用：真加载一次入口、验循环依赖

```bash
# CJS：真加载一次 + 立刻退出。PORT=0 让内核分临时端口，永不撞端口
PORT=0 NODE_ENV=test node -e 'require("./src/app.js"); console.log("loaded ok"); process.exit(0)'

# ESM：从 -e 的 CJS 上下文动态 import（相对路径按 cwd 解析）
PORT=0 node -e 'import("./src/app.js").then(()=>{console.log("loaded ok");process.exit(0)},e=>{console.error(e);process.exit(1)})'

# ESM + 顶层 await 写法
PORT=0 node --input-type=module -e 'await import("./src/app.js"); console.log("loaded ok")'

# 直接加载 TS 源码（22.6+ 实验；有 enum/装饰器要换 --experimental-transform-types）
PORT=0 node --experimental-strip-types -e 'import("./src/app.ts").then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})'

# CJS 循环依赖不会抛错 —— 必须真调一次导出才暴露
node -e 'const m=require("./src/app.js"); if(typeof m.createApp!=="function"){console.error("half-initialized, exports =",Object.keys(m));process.exit(1)}'

# 静态查环（有环 exit 1，实测）
npx madge --circular --extensions ts,js,mjs,cjs src
```

**说明**：实测 v22.23：process.exit(0) 会连已 listen 的 server 一起立刻退出，所以「PORT=0 + exit(0)」就是“真加载入口、但不卡住不占端口”的正解。循环依赖两种模块体系差异极大（实测）：CJS 版互 require 全程 **exit 0**，只打一句 `Warning: Accessing non-existent property 'fromA' of module exports inside circular dependency` 并拿到 undefined；同结构 ESM 版直接 `ReferenceError: Cannot access 'fromA' before initialization` 非零退出。madge 实测：有环 exit 1、干净 exit 0，TS 也能扫。

##### 3b. 框架专用：Fastify / Nest / Express  `[version-dependent]`

```bash
# Fastify：ready() 走完插件树/hook/路由注册，全程不 listen（实测通过）
node --input-type=module -e 'const a=(await import("./src/app.js")).build(); await a.ready(); console.log(a.printRoutes()); await a.close(); console.log("fastify smoke ok")'

# Nest：create + init + close 会把整张 DI 图实例化，专抓 "Nest can't resolve dependencies of X"
node -e 'const {NestFactory}=require("@nestjs/core");const {AppModule}=require("./dist/app.module");NestFactory.create(AppModule,{logger:false}).then(a=>a.init()).then(a=>a.close()).then(()=>{console.log("DI graph ok");process.exit(0)},e=>{console.error(e.message);process.exit(1)})'

# Express：没有 ready 钩子，唯一可靠做法是结构上拆开
#   src/app.js    -> const app=express(); ...挂路由...; module.exports=app     (不 listen)
#   src/server.js -> require("./app").listen(process.env.PORT)                (只有它 listen)
node -e 'const app=require("./src/app.js"); console.log("loaded, routes:",(app._router?.stack||app.router?.stack||[]).filter(l=>l.route).map(l=>Object.keys(l.route.methods)[0]+" "+l.route.path)); process.exit(0)'
```

**说明**：Fastify 那段是本地实测：`await app.ready()` 打出完整路由树后 close，从未绑端口 —— 它等价于“加载 + 装配全验一遍”，是三个框架里最值钱的冒烟层。Nest 的 create()/init() 不绑端口、只有 listen() 才绑，DI 错误全在这一步暴露（文档行为，本机未装 Nest 未实测）。Express 那句用的 `app._router.stack` 是私有字段且 **Express 4 叫 _router、5 起叫 app.router**，只当人工排查用，别写进 CI 断言 —— Express 的正解是靠拆 app/server 文件而不是靠探测。

#### 4. 逻辑验证  `[version-dependent]`

```bash
# 内置 runner（node 20+ 稳定）
node --test test/
node --test --experimental-strip-types 'test/**/*.test.ts'      # 22.6+

# prod 本来就是 sqlite 才用内存库（22.5+，实测可用但有 ExperimentalWarning）
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(":memory:");db.exec("create table t(a)");console.log("ok")'

# prod 是 PG/MySQL：不要换引擎。起一次性容器
npm i -D testcontainers @testcontainers/postgresql        # 需要本机 docker daemon
# 或者同引擎开一次性库，跑完 drop
DB=app_smoke_$$; createdb $DB && DATABASE_URL="postgres://u:p@127.0.0.1:5432/$DB" npx prisma migrate deploy \
  && DATABASE_URL="postgres://u:p@127.0.0.1:5432/$DB" node --test test/ ; dropdb $DB
# 每个用例包在事务里：await c.query('BEGIN') ... await c.query('ROLLBACK')  → 零残留

# 硬断“绝不乱写盘”（实测越界写报 ERR_ACCESS_DENIED）
node --permission --allow-fs-read='*' --allow-fs-write='/tmp/smoke' --test test/

# 掐断出网（--permission 管不了网络，必须靠这个）
npm i -D undici nock
# const {MockAgent,setGlobalDispatcher}=require('undici');
# const a=new MockAgent(); a.disableNetConnect(); setGlobalDispatcher(a);   // fetch/undici 全局兜住
```

**说明**：实测差异：`node:sqlite` 在 v22.23 可用、v18.20.4 直接 ERR_UNKNOWN_BUILTIN_MODULE；`--permission` 在 22 上与 `--experimental-permission` 都接受，18 上两个都是 "bad option"。**关键诚实提醒：权限模型只覆盖 fs/child_process/worker_threads/addon，不覆盖网络** —— 实测 --permission 下 net.connect 照样出去，所以“零不可逆副作用”里的“不发真请求”只能靠 MockAgent/nock。选内存 sqlite 之前先问一句：prod 是 PG/MySQL 的话 upsert 语法、JSON 函数、类型强制、隔离级别都不同，测过等于白测 —— 宁可用 testcontainers 或同引擎一次性库。

### 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- CJS/ESM 边界一致性：package.json 的 type 与 exports 字段、.mjs/.cjs 扩展名、ESM 里还在用 __dirname/require（应为 import.meta.dirname，Node 20.11+）、对 ESM-only 包用 require（Node 22.12 前抛 ERR_REQUIRE_ESM）

- async 错误路径：漏写的 await（浮空 promise 静默丢错）、Promise.all 一个 reject 拖垮整体、Express 4 里 async handler 抛错不进 error middleware（需 wrapper 或升 Express 5）、有没有 unhandledRejection 兜底（Node 15+ 默认让进程退出）

- 事件循环阻塞（Python 多 worker 下不明显、Node 单线程会拖垮整个进程）：readFileSync、大 body 的 JSON.parse、同步 crypto/zlib、可回溯爆炸的正则、循环里 await 串行化

- 类型边界的真实性：as / any / 非空断言把检查糊过去；req.body、process.env、第三方响应有没有运行时校验（zod/valibot）；tsconfig 的 strict / noUncheckedIndexedAccess 是否被关掉

- 资源与句柄泄漏（常驻进程会累积）：setInterval 没 clearInterval 也没 unref()、DB 连接池不关、stream/fs.watch 不销毁、EventEmitter MaxListeners 警告

- 停机与幂等：有没有 SIGTERM/SIGINT handler，handler 里是否 server.close() + closeIdleConnections() + 关连接池 + worker.close()；队列 handler 是否幂等（BullMQ 是 at-least-once，重启会重派）

- 依赖与产物一致性：lockfile 是否随 package.json 同提交、runtime 代码有没有 require 到 devDependency、dist 是否由本次 build 产生、engines.node/.nvmrc 与服务器 node -v 一致、native 模块是否需要 npm rebuild

- 副作用位置：模块顶层有没有连库/读文件/发请求/app.listen()/注册定时器；配置读取是否发生在 import 期（会让测试和冒烟被迫连生产）

### 本栈特有的坑

- **CJS 循环依赖“静默通过”，加载冒烟给出假绿灯；同样结构在 ESM 下却是硬崩** `[confident]`
  - 为什么：实测 v22.23：a.cjs ↔ b.cjs 互 require，进程 **exit 0**，只打一句 `Warning: Accessing non-existent property 'fromA' of module exports inside circular dependency`，拿到的是 undefined —— 半初始化的模块被当成加载成功。同结构写成 .mjs 直接 `ReferenceError: Cannot access 'fromA' before initialization` 非零退出。也就是说“加载冒烟能抓循环依赖”这句话只对 ESM 成立。
  - 怎么办：CJS 项目的冒烟不能只 `node -e 'require("./src/app.js")'`，必须真调一次关键导出并断言类型：`node -e 'const m=require("./src/app.js"); if(typeof m.createApp!=="function"){console.error(Object.keys(m));process.exit(1)}'`；再加静态门禁 `npx madge --circular --extensions ts,js,cjs,mjs src`（实测有环 exit 1、干净 exit 0）。

- **`node --check` 给的是版本相关的假安全感，TS 上直接不可用** `[confident]`
  - 为什么：实测同一份含 `import` 的 .js：v22.23.1 exit 0（22.7+ 默认开模块语法探测），v18.20.4 报 "Cannot use import statement outside a module"。stdin 不走探测（必须 --input-type=module）。`node --check t.ts` 在 22.23 报 `SyntaxError: Missing initializer in const declaration`，**加 --experimental-strip-types 依然报**。于是“本地 --check 过了”在另一台 node 版本不同的机器上可能是反的结论。
  - 怎么办：语法层按文件类型分流并锁 node 版本：.mjs/.cjs 用 `node --check`；.js 用 `node --check` 且 CI 与服务器 node 大版本一致；.ts 跳过 --check，直接 `npx tsc --noEmit -p tsconfig.json` （`npx esbuild src/**/*.ts --outdir="$(mktemp -d)"` 也行，但 glob 要让 shell 展开、outdir 要是真目录，不如 tsc 稳）。

- **TS 检查全绿 ≠ 运行时对：类型擦除会吃掉运行时真正需要的东西** `[confident]`
  - 为什么：三个实测/已知点：(1) `--experimental-strip-types` 遇到 enum 直接 `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode`（实测），要 `--experimental-transform-types`；(2) `import type` / `verbatimModuleSyntax` 下装饰器元数据被擦，Nest 的构造函数注入会拿到 undefined，而 tsc 一句不报；(3) 实测 `module: NodeNext` + `verbatimModuleSyntax` 时，最近的 package.json 少写一行 `"type":"module"` 就让 .ts 被当 CJS，`export` 报 TS1287 —— 同一份代码两台机器结论不同，差的往往就是那一行。
  - 怎么办：TS 项目的加载冒烟必须跑真实运行形态：`npm run build && node -e 'require("./dist/main.js")'`，或用项目自己的 loader（tsx / ts-node / 框架 CLI）。不要拿裸 `node --experimental-strip-types` 的结果代表生产行为。Nest 项目额外把「create + init + close 走通 DI 图」作为固定冒烟步骤。

- **顶层副作用让“冒烟”变成“打生产”** `[confident]`
  - 为什么：Node 入口普遍在模块顶层就 `dotenv.config()`、建连接池、注册定时任务、`app.listen()`。一句 require/import 就可能连上生产库、发真请求、抢占端口。`PORT=0` 只解决端口冲突（实测有效），解决不了连库和外发请求。
  - 怎么办：结构上拆：`src/app.js` 只组装并导出 app，`src/server.js` 才 listen，冒烟只加载 app 层；跑冒烟时 `NODE_ENV=test` + DATABASE_URL 指向一次性库 + `--permission --allow-fs-read='*' --allow-fs-write=/tmp/smoke`（实测越界写报 ERR_ACCESS_DENIED）。但注意权限模型不管网络（实测 --permission 下 net.connect 照样出去），断网必须用 undici MockAgent 的 `disableNetConnect()` 或 nock。

- **node 版本漂移让整套命令的结论翻转** `[confident]`
  - 为什么：实测同一批命令在 v18.20.4 与 v22.23.1 上结果不同：`require("node:sqlite")` 18 上 ERR_UNKNOWN_BUILTIN_MODULE、22 上可用（带 ExperimentalWarning）；`--permission` 18 上 "bad option"、22 上和 `--experimental-permission` 都接受；.js 里的 ESM 语法探测只有 22.7+ 默认开；`require()` ESM 图要到 22.12+ 才不抛 ERR_REQUIRE_ESM。“本地能跑、服务器炸”的一大半来源就是这个。
  - 怎么办：仓库放 `.nvmrc` + package.json `engines.node`，本地/CI/服务器三处 `node -v` 对齐；部署脚本第一行加断言：`node -e 'const [M,m]=process.versions.node.split(".").map(Number); if(M<22||(M===22&&m<12)){console.error("need node>=22.12, got",process.versions.node);process.exit(1)}'`。playbook 里每条命令都标清它依赖的最低 node 版本。
