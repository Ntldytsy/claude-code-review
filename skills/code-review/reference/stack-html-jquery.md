# 纯 HTML / jQuery 前端 · 命令映射

> **状态**：正文标注「实测」的有：node --check、eslint、html-validate、jsdom 冒烟与打桩；jQuery 3.7.1 与 4.0.0 均验证，`$.ajaxTransport` 优先级仅 4.0.0 实测。真浏览器复核没有记录。事实核查的修正已并入正文。

## 纯 HTML / jQuery 前端，无构建步骤（.html/.js/.css 直接上传，无 webpack/vite/npm run build）

### 四类动作（审查用：语法 / 静态 / 加载冒烟 / 逻辑验证）

#### 1. 语法检查  `[confident]`

```bash
# 逐文件：本栈唯一零配置门禁
find . -name '*.js' ! -path '*/vendor/*' ! -path '*/node_modules/*' ! -name '*.min.js' -print0 | xargs -0 -n1 node --check

# 按页拼接：浏览器里非 module 脚本共享一个全局作用域，逐文件看不到冲突。
# 对每个 page.html 按 <script src> 真实顺序去重拼成一个 program（文件间插 ;），再解析
rc=0
for page in *.html; do
  out="/tmp/_bundle.${page%.html}.js"; : > "$out"
  grep -ohE '<script[^>]+src="[^"]+"' "$page" | sed -E 's/.*src="([^"]+)".*/\1/' \
    | grep -vE '^(https?:)?//' | sed 's/?.*//;s#^/##' | awk '!seen[$0]++' \
    | while read -r f; do [ -f "$f" ] && { cat "$f"; echo ';'; } >> "$out"; done
  node --check "$out" || { echo "SYNTAX FAIL (page: $page)"; rc=1; }
done
```

- 实测：`node --check` 对 `$(function(){ conosle.log(a) })` 判 PASS，零名字检查；逐文件独立解析，也看不到跨文件冲突。拼接后能抓到跨文件 `let` 重复声明（线上症状：后加载的整个脚本块失效，只有一行 console 报错）。
- 必须按页拼：混拼全站会把同一个 common.js 拼多次，制造假的重复声明。
- `var` 同名是合法 JS，拼接后仍 PASS，只能靠顶层声明清单（行首锚定 grep + sort 比对）或人眼查。
- 这条抓不到什么：拼错的全局名、忘加载的库、`var` 重名、node ≥22.7 会把 `import/export` 当 ESM 判 PASS（不能反推能否当普通 `<script>` 加载）。

#### 2. 静态检查  `[version-dependent]`

- ESLint：flat config，`sourceType:'script'`（写成 module 则 `no-implicit-globals` 失效），`globals: {...globals.browser, ...globals.jquery}`（CDN 库如 moment/lodash 另加），规则至少开 `no-undef`、`no-unused-vars`、`no-redeclare`、`no-implicit-globals`(warn)；ignores 必须含 `**/vendor/**`、`**/*.min.js`。实测抓到 `conosle.log`（`no-undef`）。全站太脏时只检本次改动：`npx eslint $(git diff --name-only HEAD | grep '\.js$')`。
- html-validate（不要用系统 tidy）：`npx html-validate '**/*.html'`，关掉纯风格规则（`doctype-style`、`no-implicit-button-type`、`no-implicit-input-type`、`require-sri`）。实测抓到 `Duplicate ID` 与 `Unclosed element`。规则名随大版本变，升级后先跑一次看有没有新规则刷屏。
- 引用存在性：HTML 里本地 `src/href` 指向的文件是否真的存在（重命名/删文件后忘改 HTML 是本栈最高频事故，症状是整块功能消失而非报错）。
- 这条抓不到什么：HTML 内联 `<script>` 与 `onclick=""` 属性（ESLint 默认不看，要装 `eslint-plugin-html`，否则在结论里明说「内联脚本未做静态检查」）；运行时行为。

#### 3. 加载冒烟  `[version-dependent]`

- 做法：jsdom（`runScripts:'dangerously'`, `resources:'usable'`）加载入口 html，监听 `jsdomError` / `console.error` / `window.onerror`，等约 1.5s 后断言「0 错误」且指定全局名都存在（如 `jQuery`、`initApp`），否则非零退出。
- 必须列全局名：404 的 `<script>` 不产生 JS 错误，只断言 0 错误会漏。
- 实测：故意把 app.js 放到 jquery.js 之前，得到 `$ is not defined` 与缺失全局；顺序调回后 PASS。
- 只验「能否加载」，不要加「绑定事件数 == N」之类自造门禁。
- 这条抓不到什么：布局、canvas/IntersectionObserver 等 jsdom 缺失的 API（会假失败，换真浏览器复核，别为过 jsdom 改生产代码）；真浏览器复核无运行记录。

#### 4. 逻辑验证（jsdom + 四通道打桩）  `[version-dependent]`

隔离 = jsdom 页面 + 所有出网通道打桩，零真实请求。四通道：

1. XHR：替换 `window.XMLHttpRequest`（实测 jQuery 载入之后再换也接得住，因 jQuery 每次 send 才读取）。
2. 原生 `fetch`。
3. jQuery script/jsonp 传输层：`$.ajaxTransport('+script', ...)`，XHR 桩接不住这条，实测会真打第三方；实测它同时接住 jsonp 与 script，优先级仅 4.0.0 验证过。
4. 表单提交 / 整页跳转：覆盖 `HTMLFormElement.prototype.submit` 并对 `submit` 事件 `preventDefault`，否则整页跳转会清零 `__calls`。

```js
// 每条通道都记录到 w.__calls：{ ch, url, method, body }；fixtureFor 的 url 先归一化
const norm = u => String(u).replace(/[?&]_=\d+/, '')   // 抹掉 cache:false 时间戳，禁止 url 精确等值匹配
$.ajaxTransport('+script', opt => ({ send(h, cb){ rec('script/jsonp', opt.url, 'GET', null)
  if (opt.dataType === 'jsonp' && opt.jsonpCallback) w[opt.jsonpCallback]({}); cb(200, 'success') }, abort(){} }))
```

打桩自检（不过则后续断言全部无效）：触发一个已知会发请求的操作，`__calls.length > 0` 才算桩生效；再看通道分布 `[...new Set(__calls.map(c=>c.ch))]`，项目里有 jsonp/表单而分布只有 `'xhr'`，说明那些路径没被走到，不是「已拦住」。长度为 0 则查 `<img>` 打点 / WebSocket / SW / 内联 `location=`。

断言要能证伪自己：危险操作出现确认框且 `__calls` 无该 url；`{status:500}` / `{networkError:true}` 下失败态 UI 可恢复；同一操作连点两次该 url 只出现一次；重渲染列表两次行数不翻倍。

- 这条抓不到什么：桩之外的通道（`<img>` 打点、WebSocket、SW、`sendBeacon` 需单独补）；真实服务端行为；`fixtureFor` 写错导致的空洞通过。

### 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- **事件重复绑定**：`$(sel).on('click', ...)` 写在 AJAX 成功回调 / 渲染函数 / 页面切换里 → 每渲染一次多一个处理器，一次点击发 N 个请求（有不可逆副作用时 = N 次副作用，无任何报错）。检出：`$._data(el,'events').click.length`（实测 jQuery 3.7.1 与 4.0.0 都可用，非公开 API），或改用带命名空间的 `.off('click.ns').on('click.ns', ...)` / 委托到稳定祖先。这是本栈替代「组件生命周期」的头号 bug 维度。

- **`.html()` 重渲染后直接绑定静默失效**：实测 `$('#box').html(...)` 后，之前 `$('#b2').on('click')` 的直接绑定触发 0 次，而 `$(document).on('click','#b2')` 的委托绑定正常触发 1 次。症状是「按钮点了没反应、console 干净」。审查时对每个 `.html()/.empty()/.replaceWith()` 问一句：它清掉的子树上有没有直接绑定？

- **脚本加载顺序与全局命名冲突**：`<script>` 顺序即依赖顺序，且所有非 module 脚本共享一个全局作用域。看四件事——插件在 jQuery 之前、某个标签被加了 `async`（顺序失效）、`defer` 与内联脚本混用（执行时机翻转）、两个文件顶层声明同名（后者悄悄覆盖前者，`var` 连报错都没有）。

- **DOM 当数据真源导致的不同步**：实测 `$el.data('id')` 会缓存首读值——`attr('data-id','99')` 之后 `.data('id')` 仍返回 `7`（而 `.attr('data-id')` 是 `99`）。凡是「写 attr、读 data」或反之的地方都是 bug。同类：从 `.text()` 反解数字/状态、把选中项存在 class 里再靠 `hasClass` 判断。

- **并发 AJAX 无序返回覆盖**：本栈几乎没人存 jqXHR 去 abort。快速切换筛选/分页时先发的请求后返回，把界面盖回旧数据。审查点——每个会被连续触发的请求有没有 ① 保存 jqXHR 并在下次发起前 `.abort()`，或 ② 递增的 seq token 在 done 里比对后再渲染。对应原文的「竞态」维度。

- **定时器 / 轮询指向已被清空的容器**：`setInterval` 里 `$('#list').html(...)`，而 `#list` 已被别处 `.html('')` 掉或整个替换 → jQuery 对空集合的操作**静默无操作**，既不报错也不停轮询。这是原文「组件卸载后仍在写已销毁组件的状态」在本栈的等价物，而且更难发现（无警告）。查所有 `setInterval/setTimeout` 有没有对应的 `clearInterval`，以及切页/切 tab 时是否真的清了。

- **`.html(服务端数据)` 的 XSS**：本栈没有框架自动转义，每一处 `.html()`、`.append('<div>'+x+'</div>')`、`$('<a>').attr('href', x)` 都是注入点。按原文 §8「安全是准入维度」——只要页面渲染他人可控的内容（用户昵称、备注、文件名、URL 参数），这一轮必须过一遍：能用 `.text()` 就别用 `.html()`；拼 HTML 的地方看有没有转义函数且**每个插值都过了**。

- **默认动作未阻止导致整页跳转**：`<a href="#">`、`<button>`（默认 type=submit）、`<form>` 提交，漏掉 `e.preventDefault()` 就是整页刷新——前端所有内存状态归零、用户填的表单没了、URL 后面多个 `#`。实测 `form.submit()` 和表单默认提交都会走出去。同时检查内联 `onclick="..."`（ESLint 看不到那里，见静态检查的「抓不到什么」）。

### 本栈特有的坑

- **把「每个 .js 都 node --check 通过」当成门禁通过** `[confident]`
  - 为什么：只做语法解析，零名字检查（`conosle.log` 也 PASS）；逐文件独立解析，两个文件各自 `var config = {...}` 都 PASS，线上后者静默覆盖前者。无构建栈里它是唯一免费门禁，也因此最容易被当成全部。
  - 怎么办：叠三层才算——逐文件 `node --check`、按页拼接再 `node --check`、ESLint（`sourceType:'script'` + `no-undef`）；`var` 同名三层都不报，靠顶层声明清单比对。

- **`dataType:'jsonp'` / `'script'` 绕过 XHR 桩，打桩后仍真打第三方或生产** `[version-dependent]`
  - 为什么：jsonp/script 传输层是注入 `<script>` 标签，不经过 XMLHttpRequest（实测 jQuery 4.0.0：桩记录里一条没有，请求真的发出）。附带：`cache:false` 追加 `?_=<时间戳>` 使 url 精确匹配永远不命中、断言空洞通过；`global:false` 的请求不触发 `ajaxSend`，只靠它当记录器会漏。
  - 怎么办：四通道全打桩，`fixtureFor` 先归一化 url，并用通道分布做打桩自检（见逻辑验证）。3.x 未逐版本验证，接手时先自检确认 `script/jsonp` 出现在 `__calls` 里。

- **用系统自带 tidy 做 HTML 门禁 / 让 lint 去扫 vendor 与 *.min.js** `[confident]`
  - 为什么：macOS 自带 2006 年的 HTML Tidy，对 HTML5 报 `<main> is not recognized!` 等全是假错，真问题（重复 id、未闭合 div）混在里面；ESLint 扫 jquery.min.js 会刷出成百条。噪音大，门禁就会被整条关掉。
  - 怎么办：HTML 用 `html-validate` 并关掉纯风格规则；ESLint 的 `ignores` 写 `vendor/**`、`*.min.js`、`node_modules/**`；全站太脏时先只检本次改动文件。
