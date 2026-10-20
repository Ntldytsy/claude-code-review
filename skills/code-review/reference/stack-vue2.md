# Vue 2 前端 · 命令映射

> **状态**：源文本中没有任何「实测」声明（仅事实核查 1.4 记载本机 `rg --help` 确认了 `-L` 的含义），本栈命令视为全部未运行；因此全部置信度标签一律按 `[version-dependent]` 处理（文中个别 `uncertain` 保留）。事实核查的修正已并入正文。

适用栈：Vue 2 Options API，vue-cli 4 / webpack 4，Vuex 3 + vue-router 3 + mixins + `this.$bus` 事件总线。审查用，只验证、只提方案。

## 四类动作

### 1. 语法  `[version-dependent]`

- `.js/.jsx`：用下面 eslint 同一个 parser 兼做语法层即可（`@babel/cli` 默认没装）。
- `.vue` 的 `<template>`：Vue2 必须用 `vue-template-compiler`（与 vue 严格同号）的 `parseComponent` + `compile`，逐文件看 `errors`。Vue2 模板编译错误常常只在运行到该组件时才白屏，值得单独跑。
- 这条抓不到什么：语义错误、未定义名、运行时行为。

### 2. 静态  `[version-dependent]`

```bash
cd frontend && npx eslint --ext .js,.jsx,.vue src/ --max-warnings 0
```

- 配置必须是 `extends: ['plugin:vue/recommended', 'eslint:recommended']`（Vue2 预设），不是 `plugin:vue/vue3-*`；`env` 要含 `browser`，否则 `no-undef` 误报 window/document。预设命名：plugin-vue v7 起 essential/strongly-recommended/recommended = Vue2，vue3-* = Vue3；v6 及更早只有 Vue2 版。
- Vue2 模板天生无名字检查，可加 `vue/no-undef-properties`（plugin-vue ≥9，任何预设都不启用；对 mixin 注入、`$attrs`、`mapState` 展开会误报）、`vue/no-unused-components`、`vue/no-mutating-props`、`vue/no-side-effects-in-computed-properties`。
- 泄漏扫描（只绑不解，嫌疑清单需逐个人工确认）：`$on`/`setInterval`/`addEventListener` 的文件集合减去 `$off`/`clearInterval`/`removeEventListener` 的文件集合。注意 rg 的 `-L` 是 `--follow`，要用长选项 `--files-without-match`，且清理钩子必须包含 `deactivated`：

```bash
rg -l --glob '*.vue' 'setInterval' frontend/src | xargs rg --files-without-match 'beforeDestroy|hook:beforeDestroy|deactivated'
```

| Vue3 | Vue2（Options API） |
|---|---|
| onBeforeUnmount | beforeDestroy |
| onUnmounted | destroyed |
| onActivated / onDeactivated | activated / deactivated |

Vue2 没有 onUnmounted 这个名字（Vue 2.7 + Composition API 除外）。清理写在 `beforeDestroy`（`$refs`/`$el`/`$store` 还在）。

- 这条抓不到什么：模板里的拼写错误（默认不报）、动态绑定的监听、跨文件配对关系；文件级集合差只是线索，不是结论。

### 3. 加载冒烟  `[version-dependent]`

真把入口加载一次：jest + jsdom `require('@/main.js')`，会执行 Vuex store 创建、`Vue.use`、axios 拦截器、router 守卫等模块级副作用。入口里的跳转、埋点、自动登录请求必须先 `jest.mock`，否则冒烟本身会打真接口。循环依赖可用 `circular-dependency-plugin@5`（`failOnError: true`）跑一次 development build；`madge` 对 `.vue` 的支持 `uncertain`，不作唯一依据。

- 这条抓不到什么：未被入口触达的组件内部错误、需要真实后端的行为。

### 4. 逻辑验证  `[version-dependent]`

- 隔离测试：`@vue/test-utils@1`（v2 只支持 Vue3）+ `vue-jest@4`，`jest.mock` 掉 api/axios，每个 case 清 localStorage 与 mock。v1 要点：`propsData`、`createLocalVue`、`destroy()`（v2 分别是 `props`、`global.plugins`、`unmount()`）；`setData` 后要 `await $nextTick()`。fake timers + `w.destroy()` 是「卸载不停轮询」的回归模板。
- 读组件实例状态：Vue2 的 `el.__vue__` 挂在组件根 DOM 元素上（dev/prod 都有）；非根元素需沿 `parentElement` 上找；可读 `vm.$data`、`vm.$store.state`、`bus._events`。写状态要走 `vm.$set`，否则会误判「改了没生效」。函数式组件无实例。
- 这条抓不到什么：未 mock 掉的真实接口行为、样式与布局、真实路由下的 keep-alive 切换（需 e2e）。

## 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- 【Vue2 响应式三大盲区】改动里凡有「给对象加字段 / 按下标改数组 / 改 length」的写法，一律标红：`this.obj.newKey = v` 不触发（新 key 没有 getter/setter）→ `this.$set` 或整体替换；`delete this.obj.k` 不触发 → `this.$delete`；`this.list[0] = x` 不触发（只劫持 push/pop/shift/unshift/splice/sort/reverse 七个方法）→ `this.$set(this.list,0,x)` 或 `splice`；`this.list.length = 0` 不触发 → `this.list = []` 或 `splice(0)`。症状是「值变了、视图不动」，易被误判成接口没返回。Vuex mutation 里同理，必须 `Vue.set(state.obj,k,v)`。

- 【组件销毁清理清单】每个新增/改动的组件过一遍 beforeDestroy：clearInterval/clearTimeout、`$bus.$off`（同一函数引用）、window/document.removeEventListener、ws.close()、axios CancelToken.cancel()、IntersectionObserver/ResizeObserver.disconnect()、第三方图表实例 dispose()。被 `<keep-alive>` 包住的组件还必须有 deactivated（destroy 钩子永不触发）+ activated 里重启。

- 【事件总线成对性】`$bus.$on` / `EventBus.$on` 必须与 beforeDestroy 里的 `$off` 一一对应，且第二参必须是同一函数引用（`this.handler` 可以，匿名箭头函数解不掉）；禁止无参 `$off(event)`（会连坐清掉其它组件的监听）。审查时对比 `$on`/`$off` 的文件集合，运行时看 `bus._events[evt].length` 在反复进出路由后是否增长。

- 【mixins 的隐形耦合】同名生命周期钩子 mixin 与组件都会执行（mixin 先），两个 mixin 各自起的定时器要各自清；同名 methods/computed 组件覆盖 mixin、同名 data key 组件赢，全部静默无警告。改 mixin 前先 rg 出所有 `mixins: [xxx]` 消费方；来源不明的 `this.xxx` 先怀疑 mixin 注入（也是 `vue/no-undef-properties` 误报主因）。

- 【Options API 的固定写法约束】data 必须是函数（对象会在多实例间共享）；对象/数组 prop 默认值必须工厂函数 `default: () => ({})`；不得直接改 prop（Vue2 只 warning）；computed 里不做副作用/不改 state；watch 深层对象要 `deep: true`、需首次执行要 `immediate: true`，监听引用未变的对象（原地改字段）不会触发。

- 【v-for 的 key】必须有 `:key` 且不能用数组 index：就地复用会让「删中间一项」后剩余项复用错节点，input 值、勾选状态、展开态串行；配合 `<keep-alive>`/组件内部 data 时尤其明显。key 用业务唯一 id。

- 【构建与部署配置】publicPath 与实际部署路径一致（子路径必须写 `'/app/'`，否则 chunk 404）；vue-router history 模式必须有服务端兜底（如 Apache FallbackResource /index.html），否则深链刷新 404；index.html 必须 no-store、hash 资源 immutable；部署不得 `--delete` 清掉旧 chunk；router.onError 里有 ChunkLoadError → reload 兜底。

- 【lint/测试栈的版本正确性】eslint 配置 extends 的是 `plugin:vue/recommended` 系（Vue2）而不是 vue3-*；`@vue/test-utils` 是 1.x；`vue-template-compiler` 与 vue 版本号完全一致；新增依赖要确认支持 Vue2（很多库 3.x 已只支持 Vue3，需装 2.x 分支，如 vue-router@3、vuex@3、ant-design-vue@1.x）。

## 本栈特有的坑

- **响应式静默失效会伪装成「功能坏了」，连测试都会误判** `[version-dependent]`：`defineProperty` 下新增属性、下标赋值、改 length 值变了但无通知；单测里 `wrapper.vm.obj.k = 1` 后断言文本也会失败，让人以为模板写错。审查把这三类写法列为红线；怀疑时 `vm.$forceUpdate()`，强刷后界面对了即为响应式写法问题而非数据问题。

- **`<keep-alive>` 下 beforeDestroy/destroyed 永不执行，轮询在后台继续跑** `[version-dependent]`：切走只触发 deactivated，实例和定时器仍活着，来回切会叠成 N 条并发轮询。修法：清理抽成 `stopPoll()`，同时挂 beforeDestroy 与 deactivated，启动同时挂 mounted 与 activated（先判 `if (!this.timer)`）。只写卸载钩子的「卸载不停轮询」修法在 keep-alive 路由下修不干净。

- **`$off` 解不掉：匿名函数无法解绑，无参 `$off` 会误伤别的组件** `[version-dependent]`：两个箭头函数不是同一引用，「写了 $off 仍重复触发」；无参 `$off('evt')` 清空该事件全部监听，症状是「A 页面进出后 B 页面的实时刷新没了」，单文件阅读几乎发现不了。handler 一律用 methods 里的命名方法；审查时 `rg '\$off\([^,)]+\)' src` 找出无第二参的逐个质询。

- **webpack 里「导入了不存在的导出」只是 warning，构建成功、运行时才 undefined** `[version-dependent]`：只打印 `export 'x' was not found in '...'`，exit code 仍为 0，用户点到才 `TypeError ... is not a function`；这击穿「构建通过 = import 没问题」的假设。`.vue` 模板引用不存在的组件/方法则连 warning 都没有，只渲染成空。审查时要求把该警告当失败（grep `was not found in`），或开 `import/named`（需配 webpack resolver 认 `@` 别名，否则大量误报），并对改动涉及页面做真渲染验证。

- **Vue2 生态大版本分叉，装错的表现是莫名报错或静默不工作** `[version-dependent]`：`@vue/test-utils` 2.x、vue-router 4、vuex 4、vue-jest 5、eslint-plugin-vue 的 vue3-* 预设均面向 Vue3；`vue-tsc` 需 `vueCompilerOptions.target=2.7` 且仅对 Vue 2.7 有意义；`vue-template-compiler` 必须与 vue 完全同号，否则报 `Vue packages version mismatch` 或产生诡异模板差异。审查时检查 package.json 里这些包的大版本与 vue 是否同号，跨大版本的 `^` 范围应改为精确版本或 `~`。
