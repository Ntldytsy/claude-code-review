# 纯 HTML / jQuery 前端 · 命令映射

> **状态**：节头未给工具版本；正文多处标注「实测」（node --check、eslint、html-validate、jsdom 冒烟与打桩、rsync dry-run、macOS 上 ln/mv -h、本地起 server 的 curl 断言链；jQuery 3.7.1 与 4.0.0 均验证，`$.ajaxTransport` 优先级仅 4.0.0 实测）。正文未见实测记载的：Apache 缓存头配置（核查发现其中一条从未生效，已修）、CDN 行为、软链 403、真浏览器复核。事实核查的修正已并入正文。

## 纯 HTML / jQuery 前端，无构建步骤（.html/.js/.css 直接上传，无 webpack/vite/npm run build）

### 四类动作的命令映射（审查用：语法 / 静态 / 加载冒烟 / 逻辑验证）

#### 1. 语法检查  `[confident]`

##### 1a. 逐文件解析

```bash
# 在站点根目录跑。逐个 .js 过一遍 JS 解析器（本栈唯一「零配置」门禁）
find . -name '*.js' ! -path '*/vendor/*' ! -path '*/node_modules/*' ! -name '*.min.js' -print0 \
| xargs -0 -n1 -I{} sh -c 'node --check "{}" >/dev/null 2>&1 || { echo "SYNTAX FAIL: {}"; node --check "{}" 2>&1 | sed -n "2,5p"; }'

# 要非零退出码当 CI/部署门禁（实测 xargs 退出码 = 1）：
find . -name '*.js' ! -path '*/vendor/*' ! -name '*.min.js' -print0 | xargs -0 -n1 node --check
```

**说明**：对应原文「语法」层，且是本栈**唯一**天然存在的门禁——没有构建，语法错误否则直接进生产（浏览器只在 console 里静默报一次，页面白屏）。
实测边界（务必知道）：`node --check` 对 `$(function(){ conosle.log(a) })` 判 PASS——它**完全不做名字检查**，拼错的全局、忘加载的库一个都抓不到。所以这层只证明「没打错括号」，静态层不能省。
另：node ≥22.7 会自动按 ESM 重解析，`import/export`、顶层 await 都判 PASS（实测），旧 node 会 FAIL——别用它反推「这文件能不能当普通 <script> 加载」。



##### 1b. 本栈特有：跨文件全局作用域（按页拼接）

```bash
# 浏览器里所有非 module 脚本共享**一个**全局作用域，逐文件检查看不到冲突。
# 按页而不是按站：对每个 page.html 单独按 <script src> 的真实顺序拼成一个 program（awk 去重，保持出现顺序）再解析一次，任一页失败即失败
rc=0
for page in *.html; do
  out="/tmp/_bundle.${page%.html}.js"; : > "$out"
  grep -ohE '<script[^>]+src="[^"]+"' "$page" | sed -E 's/.*src="([^"]+)".*/\1/' \
    | grep -vE '^(https?:)?//' | sed 's/?.*//;s#^/##' | awk '!seen[$0]++' \
    | while read -r f; do [ -f "$f" ] && { cat "$f"; echo ';'; } >> "$out"; done
  node --check "$out" || { echo "SYNTAX FAIL (page: $page)"; rc=1; }
done
# 当 CI/部署门禁用时，脚本里在此 exit $rc

# var 重复声明是合法 JS，解析器永远不报 → 只能靠顶层声明清单比对：
grep -rnE '^(var|let|const|class|function|async function) [A-Za-z_$][A-Za-z0-9_$]*' --include='*.js' . \
 | grep -vE '/vendor/|\.min\.js' \
 | sed -E 's/^(.*):([0-9]+):(var|let|const|class|function|async function) +([A-Za-z0-9_$]+).*/\4\t\1:\2/' \
 | sort | awk -F'\t' '{n[$1]=n[$1]" "$2;c[$1]++} END{for(k in c) if(c[k]>1) printf "冲突 %-14s ->%s\n",k,n[k]}'
```

**说明**：这条在原 playbook 里没有对应层——因为 Python/Vue3 有模块作用域，本栈没有。
实测：拼接后 `node --check` 抓到了跨文件 `let SHARED` 重复声明（浏览器里这会让**整个后加载的脚本块 SyntaxError 失效**，前面的代码却已跑过，症状是「一半功能没了、只有一行 console 报错」）。`var cfg` 冲突拼接后仍判 PASS，所以必须配那条清单比对——实测两个文件的 `var cfg` 被列了出来。
> 注：这条必须按页拼。把 `*.html` 全部 script 混成一个列表（不去重、不分页）必然假阳性：同一个 `js/common.js` 被 5 个页面引用就会被 cat 进 bundle 5 次，其顶层 `let/const/class/function` 全变「重复声明」；只在 A 页和只在 B 页加载的文件也会被误判冲突，而浏览器里它们从不共存。

拼接时**必须**在文件之间插 `;\n`：浏览器里每个 <script> 是独立 program，ASI 不会跨文件生效，不插分号会改变语义（不一定报错，更坏）。
清单比对是行首锚定的 grep：只覆盖「列 0 的顶层声明」（正是本栈的风险形态），缩进的顶层代码和模板字符串里的伪命中要人眼过一遍。

#### 2. 静态检查  `[version-dependent]`

##### 2a. ESLint（JS 层）

```bash
npm i -D eslint globals      # 只在本地/CI 存在，不进部署产物；package.json 别传上服务器
cat > eslint.config.js <<'EOF'
const globals = require('globals')
module.exports = [
  { ignores: ['**/vendor/**', '**/*.min.js', 'node_modules/**', 'eslint.config.js'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',                       // 关键：不是 module，顶层就是全局作用域
      globals: { ...globals.browser, ...globals.jquery },   // $ / jQuery / window / document 不再误报
    },
    rules: {
      'no-undef': 'error',                        // ← 本栈最高性价比的一条
      'no-unused-vars': ['error', { args: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'no-dupe-else-if': 'error',
      'no-cond-assign': 'error', 'no-unsafe-negation': 'error', 'no-self-assign': 'error',
      'no-fallthrough': 'error', 'no-sparse-arrays': 'error', 'no-unreachable': 'error',
      'no-implicit-globals': 'warn',              // 本栈核心风险，但老代码会刷屏 → 先 warn
    },
  },
]
EOF
npx eslint . && echo '静态检查干净'

# 全站太脏时，先只守住本次改动的文件（这才是原文「抓自己新引入的 bug」那层）：
npx eslint $(git diff --name-only HEAD | grep '\.js$')

# 项目里还有 CDN 引的库（moment/lodash/bootstrap 等），把它们加进 globals 否则 no-undef 误报：
#   globals: { ...globals.browser, ...globals.jquery, moment: 'readonly', _: 'readonly', bootstrap: 'readonly' }
```

**说明**：这就是原文 §4「静态层最常抓到改动过程中自己新引入的 bug」的等价物，也是本栈**没有构建之后唯一还剩的实质门禁**。
实测：这套配置抓到了 `conosle.log`（`no-undef`）——正是原文 pyflakes 案例的同类，语法检查查不出、没测试就直接漏到线上。
三个必须做对的点，做错这层就等于没跑：① `sourceType: 'script'`（写成 module 会把顶层 var 当模块局部，`no-implicit-globals` 整条失效）；② 必须 ignore `vendor/**` 和 `*.min.js`（压缩过的 jquery 会刷出几百条，真问题被淹——正是原文「自加门禁误报代价比不加更大」）；③ 必须喂 jquery globals，否则每个 `$` 都是 no-undef，人会直接把这条规则关掉。
覆盖不到的：**HTML 里的内联 `<script>` 和 `onclick=""` 属性 ESLint 默认不看**。本栈内联脚本很多，要么装 `eslint-plugin-html` / `@html-eslint`，要么在交接里明说「内联脚本未做静态检查」。

##### 2b. HTML 结构与资源引用层

```bash
# a) HTML 结构：重复 id 和未闭合标签会**静默**毁掉 $('#x') 与 .html() 的插入位置
npm i -D html-validate
cat > .htmlvalidate.json <<'EOF'
{ "extends": ["html-validate:recommended"],
  "rules": { "doctype-style": "off", "no-implicit-button-type": "off",
             "no-implicit-input-type": "off", "require-sri": "off" } }
EOF
npx html-validate '**/*.html'

# b) HTML 引用的本地 js/css 是否真的存在（写错路径 = 生产 404 = 白屏，无构建无人拦）
grep -rhoE '(src|href)="[^"]+"' --include='*.html' . | sed -E 's/.*="([^"]+)".*/\1/' \
 | grep -vE '^(https?:)?//|^data:|^mailto:|^#|^javascript:' \
 | sed 's/?.*//;s/#.*//;s#^/##' | sort -u \
 | while read -r p; do [ -f "$p" ] || echo "MISSING: $p"; done
```

**说明**：实测 html-validate 抓到了 `Duplicate ID "row"`（no-dup-id）和 `Unclosed element '<div>'`（close-order）——这两个正是 jQuery 栈里最阴的 HTML 缺陷：`$('#row')` 只返回第一个，第二个永远拿不到；未闭合的 div 让浏览器的纠错结构与你写的不一样，`.append()` 落到别的父节点里。两者都不报错、不影响「页面看起来正常」。
关掉的四条是纯风格（`doctype-style` 要求大写 DOCTYPE 等），留着会淹掉真问题。
(b) 段实测抓到 `MISSING: css/missing.css` / `js/nothere.js`。**这条比 (a) 更该先跑**：本栈重命名/删文件时忘改 HTML 是最高频事故，且症状是整块功能消失而非报错。
注意 html-validate 的规则名与默认集会随大版本变（本次为已装版本实测），升级后先跑一次看有没有新规则刷屏。

#### 3. 加载冒烟  `[version-dependent]`

```bash
npm i -D jsdom
cat > smoke.js <<'EOF'
const { JSDOM, VirtualConsole } = require('jsdom')
const path = require('path'), fs = require('fs')
const entry = process.argv[2]
const expect = process.argv.slice(3)          // 加载完必须存在的全局名
const errs = []
const vc = new VirtualConsole()
vc.on('jsdomError', e => errs.push('jsdomError: ' + (e.message || e)))
vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ')))
const dom = new JSDOM(fs.readFileSync(entry, 'utf8'), {
  url: 'file://' + path.resolve(entry),
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
})
dom.window.addEventListener('error', e => errs.push('window.onerror: ' + e.message))
setTimeout(() => {
  for (const g of expect) if (typeof dom.window[g] === 'undefined') errs.push('缺失全局: ' + g)
  if (errs.length) { console.error('加载冒烟 FAIL'); errs.forEach(e => console.error('  - ' + e)); process.exit(1) }
  console.log('加载冒烟 PASS（0 错误，全局齐全: ' + expect.join(', ') + '）'); process.exit(0)
}, 1500)
EOF
node smoke.js index.html jQuery APP_BUILD initApp

# 真浏览器版（jsdom 报错就用它复核，这是 ground truth）：
# 用会话里的浏览器工具打开页面 → read_console_messages(onlyErrors:true) 断言为空
#   + javascript_tool 里跑：[typeof jQuery, typeof initApp, window.APP_BUILD]
```

**说明**：对应原文「导入冒烟：真的加载一次入口，验循环依赖、模块级副作用」。本栈没有 import，**等价物是 `<script>` 的加载顺序依赖 + 顶层立即执行代码**。
实测证伪能力（这层能告我）：故意把 app.js 放在 jquery.js 之前，输出 `window.onerror: $ is not defined` + `缺失全局: APP_BUILD, APP_READY`；把顺序调回来后 PASS。顺序修好前后都「构建通过」——因为根本没有构建，这正是原文「编译通过 ≠ 正确」在本栈最锋利的形态。
第二个参数往后列的全局名很重要：只断言「0 错误」会漏掉「脚本 404 了但没人抛错」的情况（404 的 script 标签不产生 JS 错误）。
严守原文反模式：**冒烟只验能否加载**。别在这里加「绑定的事件数必须 == N」之类自造门禁。
jsdom 不是浏览器：无布局、canvas/IntersectionObserver 等缺失，重度用这些 API 的页面会假失败。假失败就换真浏览器复核，不要为了让 jsdom 通过去改生产代码。

#### 4. 逻辑验证（隔离环境 + 四通道打桩）  `[version-dependent]`

```bash
# 隔离 = jsdom 页面 + **四条出网通道全打桩**，零真实请求、零不可逆副作用、可反复跑
cat > stub.js <<'EOF'
module.exports = function install(w, $, fixtureFor) {
  const calls = w.__calls = []
  const rec = (ch, url, method, raw) => {
    let body = raw
    if (typeof raw === 'string') { try { body = JSON.parse(raw) } catch (e) {} }
    calls.push({ ch, url, method, body }); return body
  }
  const norm = u => String(u).replace(/[?&]_=\d+/, '')      // 抹掉 jQuery cache:false 的时间戳

  // ① XHR（$.ajax 默认走这条；实测：jQuery 载入之后再换也接得住）
  w.XMLHttpRequest = class {
    constructor(){ this.readyState=0; this.status=0; this.responseType=''; this.upload={addEventListener(){}} }
    open(m,u){ this._m=m; this._u=u; this.readyState=1 }
    setRequestHeader(){} overrideMimeType(){} abort(){ this.onabort && this.onabort({type:'abort'}) }
    getResponseHeader(n){ return String(n).toLowerCase()==='content-type' ? 'application/json' : null }
    getAllResponseHeaders(){ return 'content-type: application/json\r\n' }
    send(raw){ const b = rec('xhr', this._u, this._m, raw)
      const f = fixtureFor(norm(this._u), b) || { status: 200, body: {} }
      setTimeout(()=>{ if (f.networkError) { this.onerror && this.onerror({type:'error'}); return }
        this.readyState=4; this.status=f.status||200; this.statusText=this.status<400?'OK':'Error'
        this.responseURL=this._u; this.responseText=JSON.stringify(f.body)
        this.response=this.responseType==='json'?f.body:this.responseText
        this.onreadystatechange && this.onreadystatechange()
        this.onload && this.onload({type:'load'}); this.onloadend && this.onloadend({type:'loadend'}) },5) }
    addEventListener(t,fn){ this['on'+t]=fn } removeEventListener(){} dispatchEvent(){ return true }
  }

  // ② 原生 fetch（新写的代码常混用）
  w.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const b = rec('fetch', url, (init&&init.method)||'GET', init&&init.body)
    const f = fixtureFor(norm(url), b) || { status: 200, body: {} }
    if (f.networkError) return Promise.reject(new TypeError('Failed to fetch'))
    return Promise.resolve(new w.Response(JSON.stringify(f.body),
      { status: f.status||200, headers: { 'content-type': 'application/json' } }))
  }

  // ③ jQuery 的 script / jsonp 传输层 —— XHR 桩接不住的那条（实测会真打第三方）
  $.ajaxTransport('+script', function (opt) {
    return { send (h, cb) { rec('script/jsonp', opt.url, 'GET', null)
        const f = fixtureFor(norm(opt.url), null) || { body: {} }
        if (opt.dataType === 'jsonp' && opt.jsonpCallback) w[opt.jsonpCallback](f.body)
        cb(f.status || 200, 'success') }, abort () {} }
  })

  // ④ 整页跳转：表单默认提交 / form.submit() —— 会清掉全部前端状态和 __calls
  w.HTMLFormElement.prototype.submit = function () { rec('form.submit()', this.action, 'POST', null) }
  $(w.document).on('submit', 'form', function (e) { rec('form-default', this.action, 'POST', null); e.preventDefault() })

  // ⑤ 顺手堵住的旁路
  if (w.navigator) w.navigator.sendBeacon = (u, d) => (rec('beacon', u, 'POST', d), true)
  return calls
}
EOF

# ── 打桩自检：原文要求的第一步，不过这步后面全部断言无效 ──
#   触发一个已知会发请求的操作，然后：
#     w.__calls.length > 0  → 桩生效
#     w.__calls.length === 0 → 没接住（走了 <img> 打点 / WebSocket / SW / 内联 onclick 直接 location=）
#                              停下来查，别相信「没有请求 = 已拦住」
#   再检查通道分布：console.log([...new Set(w.__calls.map(c=>c.ch))])
#   —— 只出现 'xhr' 而项目里有 jsonp/表单提交，说明那些路径这轮压根没被走到

# ── 断言（每条都要能证伪自己）──
#   点危险操作 → 确认框出现，且 __calls 里**没有**那个 url
#   fixtureFor 返回 { status: 500 } / { networkError: true } → 失败态 UI 可恢复
#   同一操作连点两次 → __calls 里该 url 只出现一次（本栈重复绑定的直接检出口）
#   重渲染列表两次 → $('#list tr').length 不翻倍
```

**说明**：对应原文「隔离环境跑断言、零不可逆副作用」。本栈没有数据库，隔离环境=打桩后的 jsdom；「不可逆副作用」全部在**网络出口**，所以隔离等价于「出口全堵住 + 自检确认堵住了」。
实测结论（jQuery 3.7.1 与 4.0.0 均验证）：
① 在 jQuery **载入之后**替换 `window.XMLHttpRequest`，`$.ajax` 依然被接住（jQuery 每次 send 时才读 `window.XMLHttpRequest`）——所以打桩代码可以放在页面所有脚本之后，不必抢在 jQuery 之前。
② `dataType:'jsonp'` 与 `dataType:'script'` **完全不出现在 XHR 桩记录里**，实测它们带着 `?callback=jQuery40007...` 真的发往 `https://third.party/j`。这是原文「只打桩一条通道 → 静默打到生产」在本栈的新形态，且比 XHR/fetch 二选一更隐蔽。第 ③ 段的 `$.ajaxTransport('+script', ...)` 实测两条都接住了。
③ `$.ajax({cache:false})` 会给 URL 追加 `?_=1788505794582`（实测），所以 `fixtureFor` **绝不能做 url 精确等值匹配**——否则永远命中不到、一律返回默认 200 空体，断言全部空洞通过。上面用 `norm()` 抹掉。
④ `form.submit()` 与表单默认提交实测都被接住。不堵这条，一次断言里的整页跳转会把 `window.__calls` 清零，而你会读成「没有请求」。
用 `$.ajaxTransport('+script')` 抢占优先级这一点只在 jQuery 4.0.0 实测过，3.x 未逐版本验证——接手时先用自检确认 `script/jsonp` 通道真的出现在 `__calls` 里。

### 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- **事件重复绑定**：`$(sel).on('click', ...)` 写在 AJAX 成功回调 / 渲染函数 / 页面切换里 → 每渲染一次多一个处理器，一次点击发 N 个请求（有不可逆副作用时 = N 次副作用，无任何报错）。检出：`$._data(el,'events').click.length`（实测 jQuery 3.7.1 与 4.0.0 都可用，非公开 API），或改用带命名空间的 `.off('click.ns').on('click.ns', ...)` / 委托到稳定祖先。这是本栈替代「组件生命周期」的头号 bug 维度。

- **`.html()` 重渲染后直接绑定静默失效**：实测 `$('#box').html(...)` 后，之前 `$('#b2').on('click')` 的直接绑定触发 0 次，而 `$(document).on('click','#b2')` 的委托绑定正常触发 1 次。症状是「按钮点了没反应、console 干净」。审查时对每个 `.html()/.empty()/.replaceWith()` 问一句：它清掉的子树上有没有直接绑定？

- **脚本加载顺序与全局命名冲突**：`<script>` 顺序即依赖顺序，且所有非 module 脚本共享一个全局作用域。看四件事——插件在 jQuery 之前、某个标签被加了 `async`（顺序失效）、`defer` 与内联脚本混用（执行时机翻转）、两个文件顶层声明同名（后者悄悄覆盖前者，`var` 连报错都没有）。

- **DOM 当数据真源导致的不同步**：实测 `$el.data('id')` 会缓存首读值——`attr('data-id','99')` 之后 `.data('id')` 仍返回 `7`（而 `.attr('data-id')` 是 `99`）。凡是「写 attr、读 data」或反之的地方都是 bug。同类：从 `.text()` 反解数字/状态、把选中项存在 class 里再靠 `hasClass` 判断。

- **并发 AJAX 无序返回覆盖**：本栈几乎没人存 jqXHR 去 abort。快速切换筛选/分页时先发的请求后返回，把界面盖回旧数据。审查点——每个会被连续触发的请求有没有 ① 保存 jqXHR 并在下次发起前 `.abort()`，或 ② 递增的 seq token 在 done 里比对后再渲染。对应原文的「竞态」维度。

- **定时器 / 轮询指向已被清空的容器**：`setInterval` 里 `$('#list').html(...)`，而 `#list` 已被别处 `.html('')` 掉或整个替换 → jQuery 对空集合的操作**静默无操作**，既不报错也不停轮询。这是原文「组件卸载后仍在写已销毁组件的状态」在本栈的等价物，而且更难发现（无警告）。查所有 `setInterval/setTimeout` 有没有对应的 `clearInterval`，以及切页/切 tab 时是否真的清了。

- **`.html(服务端数据)` 的 XSS**：本栈没有框架自动转义，每一处 `.html()`、`.append('<div>'+x+'</div>')`、`$('<a>').attr('href', x)` 都是注入点。按原文 §8「安全是准入维度」——只要页面渲染他人可控的内容（用户昵称、备注、文件名、URL 参数），这一轮必须过一遍：能用 `.text()` 就别用 `.html()`；拼 HTML 的地方看有没有转义函数且**每个插值都过了**。

- **默认动作未阻止导致整页跳转**：`<a href="#">`、`<button>`（默认 type=submit）、`<form>` 提交，漏掉 `e.preventDefault()` 就是整页刷新——前端所有内存状态归零、用户填的表单没了、URL 后面多个 `#`。实测 `form.submit()` 和表单默认提交都会走出去。同时检查内联 `onclick="..."`（ESLint 看不到那里，见 2a 的「覆盖不到的」说明）。

### 本栈特有的坑

- **把「每个 .js 都 node --check 通过」当成门禁通过** `[confident]`
  - 为什么：实测 `$(function(){ conosle.log(a) })` 判 PASS——`node --check` 只做语法解析，**零名字检查**；而且它逐文件独立解析，看不到浏览器里所有脚本共享一个全局作用域这件事，两个文件各自 `var config = {...}` 都 PASS，线上后者静默覆盖前者。node ≥22.7 还会自动按 ESM 重解析，`import/export` 和顶层 await 也 PASS（旧 node 会 FAIL），所以它连「这文件能不能当普通 <script> 加载」都答不了。无构建栈里这层是唯一免费门禁，也正因为免费而最容易被当成全部。
  - 怎么办：三层叠起来才算门禁：① 逐文件 `node --check`（打错字）② 按页、按 `<script src>` 真实顺序拼成一个 program（去重，文件间插 `;\n`）再 `node --check`——实测抓到跨文件 `let SHARED` 重复声明 ③ ESLint `sourceType:'script'` + browser/jquery globals + `no-undef`——实测抓到 `conosle`。`var` 同名是合法 JS，三层都不报，只能靠顶层声明清单 `sort | uniq -d` 比对（命令见 1b 的顶层声明清单）。

- **`dataType:'jsonp'` / `dataType:'script'` 绕过 XHR 桩，打桩后仍真打第三方或生产** `[version-dependent]`
  - 为什么：原 playbook 提醒的是「XHR 和 fetch 要都打」。本栈还有第三条：jQuery 的 jsonp/script 传输层是**注入 `<script>` 标签**，不经过 XMLHttpRequest。实测（jQuery 4.0.0）换掉 `window.XMLHttpRequest` 后，`$.ajax({url:'https://third.party/j', dataType:'jsonp'})` 在桩记录里**一条都没有**，实际带着 `?callback=jQuery40007...` 真的发了出去。老 jQuery 项目里 jsonp 用来跨域取配置/打点非常常见。附带两个：`$.ajax({cache:false})` 会给 URL 追加 `?_=<时间戳>`（实测），fixtureFor 做 url 精确等值匹配就永远命中不到、一律返回默认 200 空体，后面所有断言空洞通过；`$.ajax({global:false})` 的请求**不触发** `ajaxSend`（实测），只靠 `$(document).on('ajaxSend')` 当记录器会漏掉它们。
  - 怎么办：打桩要四条通道：XHR、fetch、`$.ajaxTransport('+script', ...)`（实测同时接住 jsonp 与 script）、表单提交/整页跳转。`fixtureFor` 的 url 先过 `String(u).replace(/[?&]_=\d+/,'')` 归一化。打桩自检不只看 `__calls.length > 0`，还要看 `[...new Set(__calls.map(c=>c.ch))]` —— 项目里明明有 jsonp 而通道分布里只有 `'xhr'`，说明那条路径这轮压根没被走到，别当成「已拦住」。

- **用系统自带 tidy 做 HTML 门禁 / 让 lint 去扫 vendor 与 *.min.js** `[confident]`
  - 为什么：macOS 自带的是 2006 年 Apple build 的 HTML Tidy，实测对 HTML5 报 `<main> is not recognized!`、`<meta> proprietary attribute "charset"` —— 全是假错，而真问题（重复 id、未闭合 div）混在里面。同理，ESLint 扫压缩过的 jquery.min.js 会刷出成百条，人看两次之后的反应一定是把整条规则关掉。这正是原文那条「你自己新加的门禁，误报的代价可能比不加更大」在本栈的具体形态：本栈没有构建，门禁全靠人主动跑，一噪就被弃用，然后回到零门禁。
  - 怎么办：HTML 用 `npx html-validate`（实测精准命中 `Duplicate ID`、`Unclosed element`），并把 `doctype-style` / `no-implicit-button-type` / `no-implicit-input-type` / `require-sri` 这几条纯风格关掉。ESLint 配置第一项就写 `ignores: ['**/vendor/**','**/*.min.js','node_modules/**']`。全站太脏时先只守本次改动的文件（`npx eslint $(git diff --name-only HEAD | grep '\.js$')`），把「全站干净」当渐进目标，别当准入条件。
