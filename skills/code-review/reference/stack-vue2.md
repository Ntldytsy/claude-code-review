# Vue 2 前端 · 命令映射

> **状态**：源文本中没有任何「实测」声明（仅事实核查 1.4 记载本机 `rg --help` 确认了 `-L` 的含义），本栈命令视为全部未运行；因此全部置信度标签一律按 `[version-dependent]` 处理（文中个别 `uncertain` 保留）。事实核查的修正已并入正文。

## Vue 2 前端（Options API，vue-cli 4 / webpack 4，Vuex 3 + vue-router 3 + mixins + this.$bus 事件总线，构建产物静态部署到 Apache/nginx）

### 四类动作的命令映射（审查用：语法 / 静态 / 加载冒烟 / 逻辑验证）

#### 1. 语法检查（只验打错字）  `[version-dependent]`

```bash
cd frontend
# a) .js/.jsx 纯语法（Babel 只解析不产出，不跑规则）
# 只要语法层：--out-file /dev/null（写字符设备合法，babel 把结果拼一起丢掉）；注意不是 --out-dir
npx babel src --extensions '.js,.jsx' --out-file /dev/null 2>&1 | tail -20
# 或不装 @babel/cli：node -e 调 @babel/parser 逐文件 parse()；更实际的是直接用第 2 节的 eslint --ext .js,.jsx,.vue 兼做语法层（同一个 parser）

# b) .vue 的 <template> 语法 —— Vue2 专属，必须用 vue-template-compiler
find src -name '*.vue' -print0 | xargs -0 node -e '
const c=require("vue-template-compiler"),fs=require("fs");let bad=0;
for(const f of process.argv.slice(1)){
  const sfc=c.parseComponent(fs.readFileSync(f,"utf8"));
  if(sfc.template&&sfc.template.content&&sfc.template.lang!=="pug"){
    const r=c.compile(sfc.template.content);
    if(r.errors.length){bad=1;console.log("x",f,"|",r.errors.join("; "));}
  }
}
process.exit(bad);'
echo "exit=$?  (0=模板语法全过)"
```

**说明**：vue-template-compiler 的 parseComponent/compile 是 Vue2 官方 API，vue-loader@15 项目里它已经是既有依赖（且必须与 vue 版本严格同号）。这一层比 Vue3 更值得单独跑：Vue3 用 @vue/compiler-sfc，模板错误在 vite/webpack 里立刻红；Vue2 的模板编译错误常常只在运行到那个组件时才白屏。> 注：Babel 是转译器，`--out-dir /dev/null` 会真的尝试写盘且 /dev/null 不是目录，ENOTDIR 非零退出，报的不是语法问题，最容易被误判成源码有错。

npx babel 需要 @babel/cli（vue-cli 项目默认没装，可 npm i -D @babel/cli 或用第 2 节的 eslint 兼做语法层）。



#### 2. 静态检查  `[version-dependent]`

##### 2a. 未定义名/未用变量/类型 —— 抓自己新引入 bug 的主力层

```bash
cd frontend
# 关键：Vue2 项目必须用 eslint-plugin-vue 的「非 vue3」预设
# .eslintrc.js  extends: ['plugin:vue/recommended', 'eslint:recommended']   ← Vue2
#                （不是 'plugin:vue/vue3-essential'）
# env: { browser: true, node: true, es2021: true }   ← 少了 browser，no-undef 会误报 window/document
npx vue-cli-service lint --no-fix --max-warnings 0
# 或绕开 vue-cli 直接跑，CI 里更可控：
npx eslint --ext .js,.jsx,.vue src/ --max-warnings 0

# 补上 Vue2 模板里的「未定义名」检查（默认所有预设都不开）
# .eslintrc.js rules:
#   'vue/no-undef-properties': 'error'        // {{ foo }} / this.foo 未在 data/props/computed/methods 声明
#   'vue/no-unused-properties': 'warn'
#   'vue/no-unused-components': 'error'
#   'vue/require-valid-default-prop': 'error' // 对象/数组 prop 必须工厂函数
#   'vue/no-side-effects-in-computed-properties': 'error'
#   'vue/no-mutating-props': 'error'
#   'vue/require-valid-v-slot': 'error'
#   'no-unused-vars': ['error', { args: 'after-used' }]

# TS 项目（Vue 2.7 + Volar）：
npx vue-tsc --noEmit   # tsconfig.json 里需 "vueCompilerOptions": { "target": 2.7 }
```

**说明**：这是 Vue2 里最该加码的一层，原因是 Vue2 的 template 天生没有名字/类型检查：<template> 里写错的属性名不会有任何编译期报错，只会渲染成空 —— 表现为「界面少了一块」而不是报错。vue/no-undef-properties 是 eslint-plugin-vue ≥9 才有的规则、任何预设都不启用，且对 mixins 注入的属性、$attrs、Vuex mapState 展开会误报（用 // eslint-disable-next-line 或 settings 白名单收敛）。预设命名分叉：plugin-vue v7 起 essential/strongly-recommended/recommended = Vue2，vue3-* = Vue3；v6 及更早只有 Vue2 版预设。

##### 2b. Vue2 特有：只绑不解 = 内存泄漏 + 重复触发

```bash
cd frontend
# 事件总线：$on 的文件集合 减去 $off 的文件集合 = 嫌疑清单
rg -l --glob '*.{vue,js}' '\$(bus|root)\.\$on\(|EventBus\.\$on\(' src | sort > /tmp/on.txt
rg -l --glob '*.{vue,js}' '\$(bus|root)\.\$off\(|EventBus\.\$off\(' src | sort > /tmp/off.txt
comm -23 /tmp/on.txt /tmp/off.txt      # 只绑不解 → 逐个确认

# 定时器 / 原生监听 / websocket 同法
rg -l 'setInterval\(|setTimeout\(' -g '*.{vue,js}' src|sort >/tmp/a; rg -l 'clearInterval\(|clearTimeout\(' -g '*.{vue,js}' src|sort >/tmp/b; comm -23 /tmp/a /tmp/b
rg -c 'addEventListener\(' -g '*.{vue,js}' src; rg -c 'removeEventListener\(' -g '*.{vue,js}' src
```

```js
// 运行时坐实（浏览器 console）：反复进出同一路由 3 次，数字不该增长
const bus = document.querySelector('#app').__vue__.$bus   // 你的 bus 挂载位置
Object.entries(bus._events).map(([k,v]) => [k, v && v.length])
```

**说明**：回答「事件总线不解绑会怎样」：bus 是个长生命周期的 Vue 实例，$on 把 handler 存进 bus._events[event] 数组；handler 是绑定在组件实例上的方法，闭包持有 vm → vm 持有 $el 整棵子树 → 组件销毁后整个实例和 DOM 都 GC 不掉（真泄漏）。更常被当成「玄学 bug」的是第二个后果：路由进出 N 次就绑了 N 份，一次 $emit 触发 N 次 → N 份重复请求 / N 个 toast / 重复 router.push。这确实是 Vue2 特有高发源：Vue3 删掉了实例上的 $on/$off/$emit，逼你换 mitt 并显式 off，同类问题少得多。修法固定写在 beforeDestroy：this.$bus.$off('evt', this.handler)。

##### 2c. 生命周期钩子名映射 + 「卸载不停轮询」的落地修法

```text
Vue3 → Vue2（Options API）钩子对照
  onBeforeMount   → beforeCreate/beforeMount
  onMounted       → mounted
  onBeforeUpdate  → beforeUpdate      onUpdated → updated
  onBeforeUnmount → beforeDestroy     onUnmounted → destroyed
  onActivated/onDeactivated → activated / deactivated
  onErrorCaptured → errorCaptured
清定时器/轮询写在 beforeDestroy（此时实例还完整可用），keep-alive 下还要写 deactivated
```

```js
export default {
  data () { return { timer: null } },
  mounted () {
    this.timer = setInterval(this.poll, 3000)
    window.addEventListener('resize', this.onResize)
    this.$bus.$on('job:done', this.onJobDone)
  },
  activated ()   { if (!this.timer) this.timer = setInterval(this.poll, 3000) },
  deactivated () { this.stopPoll() },     // keep-alive：destroy 钩子永不触发
  beforeDestroy () {
    this.stopPoll()
    window.removeEventListener('resize', this.onResize)
    this.$bus.$off('job:done', this.onJobDone)   // 必须同一函数引用
    this.cancelSource && this.cancelSource.cancel('component destroyed')
  },
  methods: {
    stopPoll () { clearInterval(this.timer); this.timer = null },
    async poll () {
      const r = await api.status()
      if (this._isDestroyed) return          // 在途请求晚回来，别再 setData
      this.status = r.data
    }
  }
}

// 一次性副作用的 Vue2 惯用简写（Vue3 已移除 hook: 事件）：
// const t = setInterval(fn, 1000); this.$once('hook:beforeDestroy', () => clearInterval(t))
```

```bash
# 扫描命令：起了 interval 但同文件没有清理钩子的组件（含 keep-alive 的 deactivated）
# 注意 rg 的 -L 是 --follow（跟随符号链接），不是「列出不匹配文件」；要用长选项 --files-without-match
rg -l --glob '*.vue' 'setInterval' frontend/src | xargs rg --files-without-match 'beforeDestroy|hook:beforeDestroy|deactivated'
```

> 注：旧写法 `xargs rg -L 'beforeDestroy|...'` 会把 pattern 当普通搜索，输出**已经写了** beforeDestroy 的文件，结论与意图完全相反——真正漏清定时器的组件一个都列不出来；漏掉 `deactivated` 则 keep-alive 路由下仍修不干净。

**说明**：Vue2 里没有 onUnmounted 这个名字（除 Vue 2.7 + Composition API，那里 onUnmounted 映射到 destroyed、onBeforeUnmount 映射到 beforeDestroy）。beforeDestroy 与 destroyed 都能清定时器，选 beforeDestroy 的理由是 $refs/$el/$store 都还在，可以在同一处顺带取消在途请求。this._isDestroyed 是 Vue 2.x 私有字段（destroyed 后为 true），2.x 全系可用但属于私有 API，洁癖做法是自己 data 里加 alive 标志。$once('hook:beforeDestroy') 是 Vue2 专属，Vue3 无。



#### 3. 加载冒烟（真加载入口一次，验循环依赖与模块级副作用）  `[version-dependent]`

```bash
cd frontend
# a) 循环依赖：webpack 层强断言（Vue2 常见 vue-cli 4 = webpack 4）
npm i -D circular-dependency-plugin@5
# vue.config.js:
#   const CircularDependencyPlugin = require('circular-dependency-plugin')
#   module.exports = { configureWebpack: { plugins: [ new CircularDependencyPlugin({
#     exclude: /node_modules/, include: /src/, failOnError: true, allowAsyncCycles: false }) ] } }
npx vue-cli-service build --mode development --no-clean

# b) 真的把入口加载一次（等价于后端的 python -c "import app"）
npm i -D @vue/cli-plugin-unit-jest@~4 vue-jest@^4 jest@^24 @vue/test-utils@^1
cat > tests/unit/smoke.spec.js <<'EOF'
jest.mock('axios')                        // 入口里模块级发的请求先掐掉
describe('entry', () => {
  it('main.js 能加载并挂载，不抛异常', () => {
    document.body.innerHTML = '<div id="app"></div>'
    expect(() => require('@/main.js')).not.toThrow()
    expect(document.querySelector('#app')).toBeTruthy()
  })
})
EOF
npx vue-cli-service test:unit tests/unit/smoke.spec.js
```

**说明**：关键差异：Vue3+vite 的入口冒烟可以靠 dev server 秒起，Vue2+webpack 没有这个便利，jest+jsdom require('@/main.js') 才是真正会执行「模块级副作用」的那条路（Vuex store 创建、Vue.use 注册、axios 拦截器、window 上挂东西、router 守卫注册）。注意「零不可逆副作用」的前提：入口若有 location.href 跳转、埋点上报、自动登录请求，必须先 jest.mock 掉，否则冒烟本身会打真接口。madge --circular --extensions js,vue 对 .vue 的解析支持我不确定（uncertain），别把它当唯一依据。

#### 4. 逻辑验证  `[version-dependent]`

##### 4a. 隔离环境跑断言，零不可逆副作用

```bash
cd frontend
# Vue2 必须用 @vue/test-utils@1（v2 只支持 Vue3）、vue-jest@4 或 @vue/vue2-jest
npx vue-cli-service test:unit                       # 全量
npx vue-cli-service test:unit tests/unit/shot.spec.js -t '轮询在销毁后停止'   # 单条
```

```js
// tests/unit/shot.spec.js —— Vue2 写法要点
import { mount, createLocalVue } from '@vue/test-utils'   // createLocalVue 是 v1 专属，v2 已删
import Vuex from 'vuex'
jest.mock('@/api')                                        // 隔离：不打真接口、不写真库
const localVue = createLocalVue(); localVue.use(Vuex)

it('销毁后不再轮询', async () => {
  jest.useFakeTimers()
  const store = new Vuex.Store({ modules: { job: { namespaced: true, state: () => ({}) } } })
  const w = mount(ShotCard, { localVue, store, propsData: { id: 1 } })
  jest.advanceTimersByTime(9000)
  expect(api.status).toHaveBeenCalledTimes(3)
  w.destroy()                        // v1 是 destroy()，v2 才叫 unmount()
  jest.advanceTimersByTime(9000)
  expect(api.status).toHaveBeenCalledTimes(3)   // 没涨 = beforeDestroy 真的清了
})

it('新增字段能触发重渲染', async () => {
  const w = mount(Panel)
  w.vm.$set(w.vm.form, 'title', 'x')   // 注意：w.vm.form.title='x' 不会触发更新
  await w.vm.$nextTick()
  expect(w.text()).toContain('x')
})
```

**说明**：前端没有「临时库」，隔离靠三件套：jsdom + jest.mock 掉 api/axios 模块 + 每个 case afterEach(() => { localStorage.clear(); jest.clearAllMocks() })。Vue2 与 Vue3 的 API 分叉必须记牢：v1 用 propsData（v2 是 props）、destroy()（v2 unmount()）、createLocalVue + localVue.use()（v2 用 global.plugins）、setData 后要 await $nextTick。Vue2 里 fake timers + w.destroy() 的组合就是「卸载不停轮询」这条 bug 的回归测试模板。

##### 4b. 打桩/真渲染验证：拿到组件实例读写内部状态

```js
// Vue3: el.__vueParentComponent.ctx / el.__vue_app__
// Vue2 等价物：el.__vue__   —— 挂在「组件根 DOM 元素」上，dev/prod 构建都有（devtools 就靠它）
const root = document.querySelector('#app').__vue__      // 根实例（= new Vue(...) 那个）
const vm   = document.querySelector('.shot-card').__vue__ // 任意子组件

// 元素不是组件根节点时 __vue__ 为 undefined，往上找：
const find = el => { let n = el; while (n && !n.__vue__) n = n.parentElement; return n && n.__vue__ }
const vm2 = find(document.querySelector('.shot-card .title'))

// 遍历树 / 定位组件
root.$children; vm.$parent; vm.$refs; vm.$root
const all = (v, out=[]) => (out.push(v), v.$children.forEach(c => all(c, out)), out)
all(root).filter(v => v.$options.name === 'ShotCard').length

// 读写内部状态（响应式，会真的重渲染）
vm.$data; vm.status; vm.polling = false
vm.$set(vm.form, 'newKey', 1)          // 新增字段必须 $set
vm.$store.state.job.list; vm.$store.commit('job/setList', [])   // Vuex
await vm.$nextTick(); vm.$forceUpdate()

// 事件总线现场取证
Object.entries(root.$bus._events).map(([k,v]) => [k, v && v.length])

// 找根实例（不知道挂在哪个节点时）
[...document.querySelectorAll('*')].find(e => e.__vue__ && e.__vue__.$root === e.__vue__)
```

**说明**：__vue__ / _events / _isDestroyed 都是 Vue 2.x 的私有字段，Vue3 一个都没有（Vue3 那两个还是 dev-only），所以「真渲染验证」这一段在 Vue2 里其实比 Vue3 更好做、且生产构建也能用。唯一限制：__vue__ 只在组件的根元素上，函数式组件（functional: true）没有实例、拿不到。写状态时记住走 $set / 整体替换，直接 vm.obj.k=1 只改了值不触发视图 —— 会让你误判「改了没生效」。

### 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- 【Vue2 响应式三大盲区】改动里凡有「给对象加字段 / 按下标改数组 / 改 length」的写法，一律标红：this.obj.newKey = v 不触发更新（data 初始化时才 walk + defineProperty，新 key 没 getter/setter）→ 改 this.$set(this.obj,'newKey',v) 或整体替换 this.obj = { ...this.obj, newKey: v }；delete this.obj.k 不触发 → this.$delete；this.list[0] = x 不触发（Vue2 只劫持 push/pop/shift/unshift/splice/sort/reverse 七个变异方法，不劫持索引 setter）→ this.$set(this.list,0,x) 或 this.list.splice(0,1,x)；this.list.length = 0 不触发 → this.list = [] 或 this.list.splice(0)。共同症状是「值其实变了、视图不动」，极易被误判成接口没返回。Vuex mutation 里同理，必须 Vue.set(state.obj,k,v)。

- 【组件销毁清理清单】每个新增/改动的组件过一遍 beforeDestroy：clearInterval/clearTimeout、$bus.$off（传同一函数引用）、window/document.removeEventListener、ws.close()、axios CancelToken.cancel()、IntersectionObserver/ResizeObserver.disconnect()、第三方图表实例 dispose()。被 <keep-alive> 包住的组件还必须有 deactivated（destroy 钩子永不触发）+ activated 里重启。

- 【事件总线成对性】this.$bus.$on / EventBus.$on 必须与 beforeDestroy 里的 $off 一一对应，且 $off 第二参必须是同一函数引用（this.handler 可以，匿名箭头函数解不掉）；禁止用无参 $off(event)（会连坐清掉其它组件的监听）。审查时用 comm 对比 $on/$off 的文件集合，运行时用 bus._events[evt].length 在反复进出路由后是否增长坐实。

- 【mixins 的隐形耦合】同名生命周期钩子 mixin 与组件「都会执行」（mixin 先），所以两个 mixin 各自起的定时器要各自清；同名 methods/computed 组件覆盖 mixin、同名 data key 组件赢 —— 全部静默无警告。改一个 mixin 前先 rg 出所有 mixins: [xxx] 的消费方；组件里出现来源不明的 this.xxx 时先怀疑 mixin 注入（也是 vue/no-undef-properties 误报的主因）。

- 【Options API 的固定写法约束】组件 data 必须是函数（对象会在多实例间共享状态）；对象/数组类型的 prop 默认值必须工厂函数 default: () => ({})；不得直接改 prop（Vue2 只给 warning，不报错）；computed 里不做副作用/不改 state；watch 深层对象要 deep: true、需要首次执行要 immediate: true，且监听引用未变的对象（原地改字段）不会触发。

- 【v-for 的 key】必须有 :key 且不能用数组 index —— Vue2 的就地复用策略会让「删中间一项」后剩余项复用错节点，表现为 input 里的值、勾选状态、局部展开态串到别的行；配合 <keep-alive>/组件内部 data 时尤其明显。key 用业务唯一 id。

- 【构建与部署配置】publicPath 与实际部署路径一致（子路径必须写 '/app/'，否则 chunk 请求打到根路径 404）；vue-router history 模式必须有服务端兜底（Apache FallbackResource /index.html），否则深链刷新 404；index.html 必须 no-store、hash 资源 immutable；部署不得 --delete 清掉旧 chunk；router.onError 里有 ChunkLoadError → reload 兜底。

- 【lint/测试栈的版本正确性】eslint 配置 extends 的是 plugin:vue/recommended 系（Vue2）而不是 vue3-*；@vue/test-utils 是 1.x；vue-template-compiler 与 vue 版本号完全一致；改动引入的新依赖要确认支持 Vue2（很多库 3.x 版本已只支持 Vue3，Vue2 要装它的 2.x 分支，如 vue-router@3、vuex@3、ant-design-vue@1.x）。

### 本栈特有的坑

- **响应式静默失效会伪装成「功能坏了」，连你写的测试都会误判** `[version-dependent]`
  - 为什么：Vue2 用 Object.defineProperty，新增属性、数组下标赋值、改 length 三种写法「值真的改了但没有通知」。于是排查时看到 this.form.title 已经是新值、接口也返回了，界面就是不动；点一下别的东西（触发了其它 re-render）又突然对了 —— 很容易被归因成「后端偶发」「浏览器缓存」。在单测里同样成立：wrapper.vm.obj.k = 1; await $nextTick(); expect(wrapper.text()).toContain('1') 会失败，让人以为组件模板写错了。Vue3 换 Proxy 后这一整类问题不存在，所以从 Vue3 项目搬过来的 playbook 完全没有这一层。
  - 怎么办：审查层：把「新增字段 / 下标赋值 / length」列为改动红线，统一走 this.$set / this.$delete / splice / 整体替换新对象；已知会动态加字段的对象在 data 里先声明好全部 key（占位 null）。验证层：单测和 console 打桩都用 vm.$set(...) 写状态；怀疑响应式失效时先 vm.$forceUpdate() 一下 —— 如果 forceUpdate 后界面就对了，100% 是响应式写法问题而不是数据问题。

- **<keep-alive> 下 beforeDestroy/destroyed 永远不执行，轮询在后台继续跑** `[version-dependent]`
  - 为什么：被 keep-alive 缓存的组件切走只会触发 deactivated，实例和定时器都还活着。表现是「退出详情页后网络面板里 3 秒一次的 status 请求还在刷」，来回切几个 tab 就叠成 N 条并发轮询，看起来像后端被打爆或前端疯了。原 playbook 那条「卸载不停轮询」的修法只写了卸载钩子，在 keep-alive 路由（Vue2 项目里 <keep-alive><router-view/></keep-alive> 是标配写法）下修不干净。
  - 怎么办：清理逻辑抽成 this.stopPoll()，同时挂在 beforeDestroy 和 deactivated 上，启动逻辑同时挂 mounted 和 activated（activated 里判 if (!this.timer) 防重复）。验证：进入页面 → 切走 → 观察网络面板 10 秒应无该请求 → 切回应恢复；自动化用 wrapper.destroy() 之外再补一条 wrapper.vm.$options.deactivated 存在性断言，或用 e2e 走真实路由切换。

- **$off 解不掉：匿名函数无法解绑，而无参 $off 会误伤别的组件** `[version-dependent]`
  - 为什么：$bus.$on('evt', () => this.reload()) 之后无论怎么写 $off('evt', () => this.reload()) 都解不掉（两个箭头函数不是同一引用），于是「我明明写了 $off」但重复触发依旧。反过来图省事写 $bus.$off('evt') 会清空该事件的全部监听 —— 把同时在监听这个事件的其它组件一起弄哑，症状是「A 页面进出一次以后 B 页面的实时刷新就没了」，这种 bug 几乎不可能靠读单个文件发现。
  - 怎么办：handler 一律写成 methods 里的命名方法（Vue2 会把 methods 一次性 bind 到 vm，引用稳定），配对写 this.$bus.$on('evt', this.onEvt) / this.$bus.$off('evt', this.onEvt)。审查时 rg '\$off\([^,)]+\)' src 找出所有无第二参的 $off 逐个质询。运行时取证：Object.entries(bus._events).map(([k,v])=>[k,v&&v.length])，进出路由 3 次后数字不涨、且切走 A 页面后 B 页面关心的事件数量没减少。

- **webpack 里「导入了一个不存在的导出」只是 warning，构建照样成功、上线后运行时才 undefined** `[version-dependent]`
  - 为什么：import { getShotList } from '@/api' 里名字打错，webpack 只打印 "export 'getShotList' was not found in '@/api'" 这一行 warning，exit code 仍是 0，CI 全绿，dist 正常产出，直到用户点到那个按钮才 TypeError: _api.getShotList is not a function。这正好击穿原 playbook 的假设 —— 后端 python -c "import app" 会当场 ImportError 炸掉，前端不会。Vue2 项目的 .vue 模板里更隐蔽：模板引用了不存在的组件/方法名，连 warning 都没有，只是渲染成空。
  - 怎么办：① CI 里把警告当失败：npx vue-cli-service build 2>&1 | tee /tmp/b.log; grep -q "was not found in" /tmp/b.log && exit 1；② eslint 开 import/named + import/default（需 eslint-plugin-import 并配好 webpack resolver 才认得 @ 别名，否则会大面积误报，属 version-dependent）；③ 模板侧靠 vue/no-undef-properties + vue/no-unused-components 补位；④ 收尾必须做一次真渲染验证（走一遍改动涉及的页面），不能只看构建成功。

- **Vue2 生态版本号分叉，装错大版本的表现是「一堆莫名其妙的报错或静默不工作」，不是清晰的不兼容提示** `[version-dependent]`
  - 为什么：同名包的高版本大多已只支持 Vue3：@vue/test-utils 2.x（mount 直接报错/API 全变，v1 才有 createLocalVue、propsData、destroy()）、vue-router 4.x、vuex 4.x、vue-jest 5.x/@vue/vue2-jest、eslint-plugin-vue 的 vue3-* 预设（会把正常的 Vue2 写法报成 deprecated，同时漏掉真问题）、vue-tsc 需要 vueCompilerOptions.target=2.7 且只在 Vue 2.7 有意义。最刺人的是 vue-template-compiler：它必须与 vue 完全同一个版本号，npm install vue 单独升了小版本就会在构建时报 "Vue packages version mismatch"（vue-loader@15 会校验），或在没有校验的路径上产生诡异的模板编译差异。
  - 怎么办：锁版本并在 CI 前置断言：node -e "const a=require('vue/package.json').version,b=require('vue-template-compiler/package.json').version;if(a!==b){console.error('mismatch',a,b);process.exit(1)}"；升 vue 时同步 npm i vue@X.Y.Z vue-template-compiler@X.Y.Z；package.json 里对 vue-router/vuex/@vue/test-utils 用精确版本或 ~ 而不是 ^ 跨大版本；新增依赖前先看它的 README 是否标注 Vue 2 支持分支。
