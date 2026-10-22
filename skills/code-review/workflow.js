export const meta = {
  name: 'code-review',
  description: '多维度并行审查 + 每条对抗性验证(默认证伪)',
  phases: [
    { title: 'Find',       detail: '各维度并行找问题' },
    { title: 'Verify',     detail: '逐维度对抗性验证，默认立场不成立' },
    { title: 'Synthesize', detail: '按判定结果汇总' },
  ],
}

// 入参（全部可选；不改本文件、只靠 args 就能跑）：
//   paths      {分区名: 绝对路径}              被审代码
//   project    string                          替换下面「这是什么/不可逆副作用/团队标准」三段
//   known      string[]                        已知问题
//   only       string[]                        只跑这些默认维度，如 ['backend-bugs']（成本表的「轻量/标准」就靠它）
//   skip       string[]                        跳过这些默认维度
//   extraDims  string[]                        追加可选维度：'security' / 'reuse-consistency' / 'llm-async' / 'tests'
//   dims       [{key,role,focus}]              完全自定义，传了就只跑它们
//   mode       'cleanup'                       整理瘦身模式：只跑 dead-code + simplify（≈ only: ['dead-code','simplify']）
//   shard      true                            大仓库：每个维度按 paths 分区各起一个找手（agent 数 = 维度×分区×…，成本成倍）
//   inject     {维度key: [发现...]}            跳过该维度的找手，直接把这些发现交给验证员（单测验证员 / 复验用，格式同找手输出）
//   diffBase   string                          只审 `git diff <diffBase>...HEAD` 涉及的文件（日常省钱用）
const P = (typeof args === 'object' && args) || {}

// ── ① 被审代码分区。键就是你项目的代码分区名，自己定，数量不限 ──────
const PATHS = P.paths || {
  '【按项目填:分区名，如 后端/前端/CLI/packages/core】': '【按项目填:绝对路径】',
}

// ── ② 项目背景：每个 agent 都会看到这段 ─────────────────────────────
const PROJECT_BODY = P.project || `
# 这是什么
【按项目填:一段话说清项目做什么、主要流程、关键机制(鉴权/异步/状态存哪)】

# 本项目的「不可逆副作用」有哪些
【按项目填:付费外部调用 / 发真实邮件短信 / 写生产数据 / 触发第三方 webhook /
 占用长时后台任务。agent 会据此判严重度。若确实一个都没有，写"无"】

# 团队的明确标准
【按项目填:引用你自己说过的原话，例如"只要满足要求的最简单方案""过度设计本身就是缺陷"】
`
const PROJECT = `
# 被审代码
${Object.entries(PATHS).map(([k, v]) => `- ${k}：${v}`).join('\n')}
${P.diffBase ? `
# 审查范围（重要）
只审改动面：先在被审目录里跑 \`git diff --name-only ${P.diffBase}...HEAD\` 拿到文件清单，
**只读、只报这些文件里的问题**；需要看调用方/上下文时可以读别的文件，但问题本身必须落在改动文件上。
` : ''}
${PROJECT_BODY}
`

// ── 模板没填就炸,别让一整轮 agent 拿着占位符白跑十几分钟 ──────────
//    (同 playbook §4「编辑本身要 fail-loud」:没命中就炸,绝不静默跳过)
// 只认「【按项目填」这个固定前缀：用户自己写的项目描述/已知问题里常有「【重要】」之类的全角括号，不能被误当成占位符
const 占位 = (v) => typeof v === 'string' && v.includes('【按项目填')
const 未填 = [
  ...Object.entries(PATHS).flatMap(([k, v]) => (占位(k) || 占位(v) ? [`PATHS: ${k} → ${v}`] : [])),
  ...(占位(PROJECT) ? ['PROJECT: 项目背景 / 不可逆副作用 / 团队标准'] : []),
]
if (未填.length) {
  throw new Error(
    `workflow.js 还有【按项目填】没替换,已中止(否则 agent 会拿着占位符跑完整轮):\n- ${未填.join('\n- ')}`,
  )
}

// ── ③ 已知问题：防止 agent 把上一轮的结论再报一遍 ────────────────────
//    没填不中止(首次跑本来就没有已知问题),但占位符要滤掉,否则它会作为
//    一条"已知问题"进 prompt,agent 读到的是一句没有意义的指令
// 参数形状校验：known 传成字符串会被展开成一个个字符；paths 为空会让 agent 在没有「被审代码」的情况下开跑
for (const [名, 值] of [['known', P.known], ['only', P.only], ['skip', P.skip], ['extraDims', P.extraDims]]) {
  if (值 !== undefined && !Array.isArray(值)) throw new Error(`args.${名} 必须是数组，收到 ${typeof 值}`)
}
if (P.extraKnown !== undefined) throw new Error('args.extraKnown 已移除，请改用 args.known（直接忽略会让已知问题静默失效、旧问题被重复报）')
if (Object.keys(PATHS).length === 0) throw new Error('args.paths 为空：没有任何被审路径')

const KNOWN = [
  '【按项目填:上一轮已确认或已拍板不改的问题，一行一条。首次跑可留空数组】',
  ...(P.known || []),
].filter((k) => !占位(k))

const CONTEXT = `${PROJECT}

# 搜索范围
**问题只报「被审代码」列出的路径里的**。为了查清调用方/引用（尤其是死代码要确认没人用），
允许**只读地**在被审路径所在的同一个仓库里搜索其他位置；但不要读评测/答案/说明类文件，也不要离开这个仓库。

# 只读（硬规矩）
本轮只审查，**不得修改、删除、移动、新建被审路径下的任何文件**，不得执行会改变仓库或外部状态的命令
（git commit/checkout/reset、写库、调外部服务等）。只允许读文件、rg/grep、静态检查器、只读的 git 命令。

# 已经找过、不要重复报告的问题
${KNOWN.map((k) => `- ${k}`).join('\n')}
`

// 两类发现，找法与判法完全不同，不能共用一套标准——
// 「缺陷」要能推演出失败场景；「精简」（死代码/冗余/过度设计）本来就没有失败场景，
// 它的依据是「查清影响面后确认能删/能简化」。共用一套会把精简类全部毙掉
const OUT_BUG = `# 输出要求（缺陷类）
只报你能在代码里指出具体行、并说清"什么输入/什么时序会出错"的问题。
宁缺毋滥：拿不准的不要报。不要报纯风格问题，不要报上面已列出的。
注意：**缩进/引号/命名/内部结构的差异 = 纯风格，不报**；但**同一个操作在不同页面
呈现给用户的样子不一致（按钮主次或颜色、文案、位置、交互、报错提示）不是风格问题**，
它是用户能看见的缺陷，该报。
所有发现 kind 填「缺陷」。`

const OUT_CLEAN = `# 输出要求（精简类：死代码 / 冗余 / 过度设计）
本轮的目的是**让代码更简洁、更好维护**。AI 写的代码常见：多余的方法、没必要的抽象、过度防御、
同一逻辑写多遍、绕远路。**这些没有"失败场景"，但同样要报**——别因为"它不会出错"就不报。
- 所有发现 kind 填「精简」；failure 字段写「留着它的代价」（读者负担/维护风险/误导/重复漂移），不是失败场景
- **影响面必须你自己查清再写进 impact**：对要删/要改的每个符号做带符号名的全仓搜索（用 rg，**不要加文件后缀过滤**；
  命中 0 时先自检过滤器再下结论），并检查**动态引用**：字符串拼接出的名字、反射/getattr、
  路由/配置/DI/模板/序列化里按名字引用、测试、对外导出的公共 API。impact 里写「搜了什么 → 命中什么」
- fix 写成**可直接照做的步骤**：删哪几行/哪个文件，连带会变成孤儿的 import/变量/函数也一并列出；
  简化类要写出简化后的样子（伪代码或具体改法），并说明**行为为什么等价**
- cleanupType：整段删掉填「删除」，留着但改更简单的写法填「简化」（别因为是死代码维度就一律填删除）
- linesSaved 给预计净减少的行数；risk 写风险（低/中/高 + 原因）
- **净减 0 行的纯命名/微小可读性问题不报**（如把未使用的循环变量改成下划线）
- 拿不准能不能删（有动态引用、对外 API、跨仓库）也要报，在 risk 里写明——由验证员和用户决定
- **needsDecision 别滥用**：「是否对外 API」只有**有迹象**才写——库/包的入口、\`__all__\`、文档或 README 里提到、
  被其他仓库引用。应用内部函数/脚本没有这些迹象，就不要写 needsDecision，在 risk 里写「低」即可。
  needsDecision 只留给真要人拍板的（抽公共模块、行为会变、对外契约）
- **为「让常见情况成功」而写的处理要留，不报**（如解析模型输出前剥掉 \`\`\`json 包裹）；只有「防不可能发生的情形 / 已被外层兜住」才算冗余
- 不报纯命名/缩进/引号偏好；不报上面已列出的`

const findingsSchema = (cap) => ({
  type: 'object',
  required: ['findings', 'suppressed'],
  properties: {
    // 上限是硬的。超了必须在 suppressed 里报数，否则被砍掉的条目无声消失
    suppressed: { type: 'integer', description: `你实际找到、但因 ${cap} 条上限没报上来的条数。没有就填 0` },
    findings: {
      type: 'array',
      maxItems: cap,
      items: {
        type: 'object',
        required: ['kind', 'title', 'file', 'line', 'evidence', 'failure', 'fix', 'severity'],
        properties: {
          kind:     { type: 'string', enum: ['缺陷', '精简'], description: '缺陷=会出错；精简=死代码/冗余/过度设计，不出错但该删或该简化' },
          title:    { type: 'string', description: '一句话说清问题' },
          file:     { type: 'string' },
          line:     { type: 'integer' },
          evidence: { type: 'string', description: '贴出关键代码，说明为什么是问题' },
          failure:  { type: 'string', description: '缺陷：具体失败场景（什么输入/时序 → 什么错误结果）。精简：留着它的代价（读者负担/维护风险/误导/重复漂移）' },
          fix:      { type: 'string', description: '缺陷：最简修法，只写必要那几行，匹配周围风格。精简：可直接照做的删除/简化步骤，含连带孤儿' },
          alternatives:  { type: 'string', description: '若存在不止一种合理改法，并列写出其他改法与取舍；只有一种就留空。不要静默替用户选' },
          impact:        { type: 'string', description: '缺陷：动到别人依赖的什么+消费方。**精简：必填**，写「搜了什么 → 命中什么」，含动态引用检查结果' },
          needsDecision: { type: 'string', description: '真需要人拍板的原因（改表/产品语义/成本策略/抽公共模块/为性能牺牲简洁/**有迹象表明是对外 API**）；不需要就留空。别因为"理论上可能被外部调用"就填' },
          cleanupType:   { type: 'string', enum: ['删除', '简化'], description: '精简类：整段删掉=删除；留着但换更简单的写法=简化（决定报告里归到「可删除」还是「可简化」）' },
          linesSaved:    { type: 'integer', description: '精简类：预计净减少行数' },
          risk:          { type: 'string', description: '精简类：风险（低/中/高 + 原因）' },
          severity: { type: 'string', enum: ['A-阻断', 'B-重要', 'C-建议'], description: '精简类一般填 C-建议' },
        },
      },
    },
  },
})
const CAP = { 缺陷: 8, 精简: 15 }

const VERDICT = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        // index 必填：按序号回填。别按 title 匹配——验证员会改写标题，匹配不上就全成"未判定"
        required: ['index', 'verdict', 'reason'],
        properties: {
          index:   { type: 'integer', description: '对应上面第几条(从 1 开始)' },
          // 三态而不是 true/false：两态会逼验证员把"我没读明白"压成"不成立"，
          // 于是被错杀的真问题和真正的假阳性混进同一桶，抽查时无从下手
          verdict: {
            type: 'string',
            enum: ['成立', '不成立', '读不出结论'],
            description: '缺陷：能推演出失败场景=成立。精简：查清影响面后确认能删/能简化=成立。被挡住/不可能/有活引用=不成立；证据不足以判定=读不出结论',
          },
          reason: { type: 'string', description: '你读了哪些行、为什么确认或否掉' },
          correction:       { type: 'string', description: '若原描述(含行号)有误但问题仍成立，写出准确描述' },
          severityAdjusted: { type: 'string', enum: ['A-阻断', 'B-重要', 'C-建议'], description: '只有你认为找手的严重度不对时才填；只能是这三个值之一（不要写「C」「低」「降为C级」这类自由文本）' },
          correctedLine:    { type: 'integer', description: '若找手报的行号有偏差，这里写真实的起始行号（报告会采用它）；没偏差就省略' },
          // 精简类的验证员必须自己搜一遍并写在这里；空的话汇总时会把「成立」降级成「读不出结论」
          impactChecked:    { type: 'string', description: '精简类必填：你自己做的消费方搜索——命令、命中结果、动态引用检查结论' },
        },
      },
    },
  },
}

// ── ④ 审查维度。下面四个是**示例**：前两个假设了「关系型库+ORM+事务」的后端
//    和「SPA 组件生命周期+轮询」的前端。换技术栈时**替换 focus 里的重点清单**，
//    否则该维度会整段空转。dead-code / simplify / flow-sanity 基本与栈无关，建议保留。
const DEFAULT_DIMS = [
  {
    key: 'backend-bugs',
    role: '后端正确性审查员。只找**真实缺陷**，不找风格问题',
    focus: `- 异步/后台任务里数据库连接与事务的生命周期；中途多次提交时异常路径会留下什么状态
- 并发写同一行/同一资源：会不会互相覆盖、产生孤儿数据
- 失败后的状态机：有没有可能永久卡在"进行中"
- 事务边界：先删后加、先改本地后调外部服务，中途抛异常会怎样
- 重试/清理逻辑与正在跑的任务之间的竞态
- 权限与归属校验：有没有漏网的入口，或者反而误伤了正常路径
- 外部调用的容错：一次网络抖动会不会丢掉一个"已经产生不可逆副作用"的任务
- 写入前的字段约束：目标列的类型/长度/序列化方式（JSON 列要序列化、严格模式下超长是**报错而非截断**），别拿另一个字段的经验套这个字段
- 位置耦合与写死常量：按位置取值的硬下标、写死的尺寸/上限/magic number——上游一变就静默错位
- 性能（只报明显的，C 级，且 needsDecision 写明"简洁 vs 性能"，**不要擅自要求优化**）：N+1、能在数据层一次解决却在内存里循环、无谓的全量扫描`,
  },
  {
    key: 'frontend-bugs',
    role: '前端正确性审查员。只找**真实缺陷**，不找风格问题',
    focus: `- 轮询/定时器的启停：组件卸载后是否仍在跑并写已销毁组件的状态；切走再回来会不会叠出多条
- 加载/禁用标志被多处写：某个操作进行中，别的按钮是不是还能点
- 竞态：批量操作进行中又触发单条操作
- 服务器数据合并回本地时，会不会覆盖用户**正在输入**的内容
- 本地临时标记在刷新、切换、重新载入后是否残留或丢失
- 状态重置是否完整（切换主体时所有相关状态都清了吗）
- 快照/脏值比较的正确性：null 与 0、空串、数组顺序
- 错误拦截器与轮询/重试的交互
- 新用到的组件/库是否真的被引入、注册、安装并被打包进来（不注册的组件常常静默不渲染、无报错、编译照过）
- 位置耦合与写死常量：按下标取值、写死的尺寸/magic number，上游布局或数据顺序一变就静默错位`,
  },
  {
    key: 'dead-code',
    kind: '精简',
    role: '死代码审查员。找**可以安全删除的代码**，并把影响面查清楚。不找缺陷',
    focus: `**方法（必须照做）**：先枚举定义——函数/方法/类/导出/路由/组件/常量/配置项/样式类/依赖包，
再对**每一个**名字做带符号名的全仓搜索；命中只有定义本身 = 候选。然后检查动态引用
（字符串拼接名、反射/getattr、路由/配置/DI/模板里按名字引用、测试、对外导出的公共 API）。
大仓库按 PATHS 分区逐个扫，别只抽查几处。
- 没有任何引用的函数/方法/类/导出/路由/组件/常量/配置项/样式类/依赖包
- 只被死代码引用的代码（连锁死亡：删了 A，B 也就没人用了，要一并列出）
- 触发点已被注释掉/删除，但下游整条链路还留着的"死链路"
- **当前环境永远走不到的分支**：为不可能的场景写的降级/兼容/兜底
- 被注释掉的大段旧代码、已完成的 TODO 残留、遗留的临时 console.log / 观测日志
- 未使用的 import / 变量 / 参数
- 注释与代码不符（注释描述的是旧行为）
- ⚠️ 排除项：**为"让常见情况成功"而写的处理要留**（如剥掉 \`\`\`json 包裹）。框架按约定调用的魔法名
  （生命周期钩子、约定路径文件、序列化/DI 按名字调用）不是死代码。对外导出的公共 API
  不能断言没人用——有迹象（库入口、__all__、文档提到）才要报并写 needsDecision；
  纯应用内部的函数不必每条都问「是否公共 API」`,
  },
  {
    key: 'simplify',
    kind: '精简',
    role: '简化审查员。AI 写的代码常常过度复杂；找**可以更简单、且行为等价**的代码',
    focus: `判据：「一个资深工程师会不会说这过度复杂了？」「删掉/内联它，结果变不变？」不变就该报。
- 只有一处使用的 helper/函数/类/抽象层/配置项/参数/开关——可以内联
- 只为一个两行函数而存在的模块、多层转发/包装、一层包一层
- 为不可能场景写的防御：不会发生的 null/类型判断、已被外层兜住的 try/catch
- 同一逻辑的多份实现（含逐字复制的分支），以及它们已漂移出的差异——合并成一份
- 为假设需求预留、至今没有使用者的抽象与配置
- 能在数据层一次解决的事，却在内存里多轮循环/多层转换；手写了框架/标准库现成就有的能力
- 绕远路：先转成 A 再转成 B 只为拿到 A；冗余的中间变量/状态/缓存；一次性使用的临时结构
- 过长的函数：50 行能写成 15 行且行为不变
- 简化后必须**行为等价**——写出等价依据；做不到等价的不报
- ⚠️ 排除项：「让常见情况成功」的处理要留；已有 ≥2 处真实复用且抽取合理的不报；
  纯命名/缩进/引号偏好不报。跨文件抽公共模块要 needsDecision（先与协作方确认）`,
  },
  {
    key: 'flow-sanity',
    role: '产品流程审查员。从**真实使用者**角度找不合理的地方，不看代码风格',
    focus: `- **有不可逆副作用的操作**：误点、返回上一步再进入、刷新页面、点"全部重来"分别会发生什么？
  会不会重复产生副作用？有没有二次确认？
- 失败后用户能不能自己恢复？失败的部分会不会挡住后续步骤？
- 会"隐式新建"还是"就地修改"？这个规则用户能感知到吗？会不会意外覆盖旧数据？
- 导航可以任意跳转时，跳到还没有数据的步骤会看到什么？
- 依赖的资源被删除/失效后，引用它的地方怎么办？
- 私有与公开、默认开与默认关：语义有没有冲突？默认值对用户是不是意外？
- 边缘层：空状态、每种类型/分组、输入的异常格式（表头行、分隔符、超长）、显示命名——设计期就能预见的返工`,
  },
]

// ── ⑤ 可选维度:**不在 DEFAULT_DIMS 里**,要用就显式加。每加一个 = +2 agent ≈ +20 万 ──
//    启用方式二选一:
//      a) 起工作流时传 args.extraDims: ['security'](在默认维度之外**追加**)
//      b) 改这个文件:把 EXTRA_DIMS.security 写进 DEFAULT_DIMS
//    (args.dims 是另一回事:传了它就**只跑你传的那些**,默认维度和这里的都不参与)
const EXTRA_DIMS = {
  // 【什么时候必须加】项目涉及以下任一项 → 安全是准入维度,不是"有症状再查":
  //   凭证/密钥 · 支付 · 他人个人信息 · 多租户数据隔离 · 文件上传 · 对外开放的写接口
  //   理由:安全问题的特征就是没有症状——越权读他人数据、密钥进仓库,在被利用前既不慢也不报错
  security: {
    key: 'security',
    role: '安全审查员。只报你能指出具体行、并说清**攻击者具体怎么利用**的问题，不报"建议加固"',
    focus: `- 鉴权与归属：每个写接口都校验了"这条数据属于当前调用者"吗？有没有只校验了登录、没校验归属的入口
- 越权枚举：把 URL / 请求体里的 id 换成别人的，能不能读到或改到？返回的错误信息会不会泄露"这条存在"
- 多租户隔离：每一处查询都带上了租户/归属过滤吗？有没有某个分支、某个后台任务漏了
- 注入：拼进 SQL / 命令行 / 模板 / 反序列化 / 动态导入的外部输入，走的是参数化或白名单吗
- 密钥落地：仓库里、配置样例里、日志里、报错信息里有没有明文凭证？**前端打包产物里有没有本该只在服务端的 key**
- 上传：类型/后缀/大小/存储路径是白名单校验吗？能不能穿越目录，或落进可被直接执行/直接访问的目录
- 对外开放的写接口：有没有漏挂鉴权的路由？有没有限流与防重放
- 报错与日志：异常信息会不会把栈、SQL、内部路径、令牌原样吐给调用方或写进日志`,
  },

  // 【什么时候加】项目调用大模型生成内容、或有慢的异步生成任务
  'llm-async': {
    key: 'llm-async',
    role: 'LLM 功能与异步任务审查员。只报能指出具体行、并说清**会产生什么坏数据或卡死状态**的问题',
    focus: `- Prompt 模板的占位符与调用方传入的键是否一一对应；承载"整个输入"的关键占位符缺失时是 **fail-loud**（报错/标失败）还是**静默生成一堆垃圾**
- 慢任务是否用"立即返回哨兵 + 轮询"而不是同步等待（会超时）；轮询有没有超时上限、间隔是否合理
- **进程重启后，上一轮残留的"生成中"占位是否被清理成"失败"**——否则永远卡在"生成中"
- 失败路径是否写了"失败"哨兵，而不是留空或留旧值
- 哨兵/特殊标记值是否贴合存储字段的类型（JSON 列存序列化、字符串列存裸串），别混
- 模型输出解析：是否处理了代码块包裹等高频格式；解析失败时是报错还是吞掉继续
- 付费调用的重试：超时/抖动重试会不会对"已经产生不可逆副作用"的调用重复扣费`,
  },

  // 【什么时候加】改了行为却不确定有没有测试兜住、或代码是 AI 写的而测试也是 AI 写的
  tests: {
    key: 'tests',
    role: '测试质量审查员。找**测试兜不住的地方**：改坏了测试也不会失败，或改了行为却没有对应测试。只报能指出具体行、并说清「什么改动会溜过去」的问题',
    focus: `- 行为分支没有任何测试覆盖：失败路径、边界值、空输入、并发/重试路径；尤其是「不可逆副作用」那条链路
- **断言为空或太弱**：只断言「没抛异常」「返回值非空」「调用了某函数」，把函数体改成 return None 测试也照过
- **过度 mock**：把被测对象本身 mock 掉，或 mock 到测的只是 mock；外部依赖该打桩的地方没打桩，导致测试会打到真实服务
- 测试与实现耦合：断言的是内部调用顺序/私有函数，重构后会大面积误红，而真正改坏逻辑反而不红
- 测试依赖执行顺序、共享全局状态、当前时间、网络、随机数——会偶发失败，久了会被人关掉
- 修过的 bug 没有回归用例（git log 里有 fix 提交、却找不到能复现它的测试）
- 测试数据与生产形状不一致：字段缺失、类型不对、没有覆盖 null/空串/超长
- ⚠️ 不要要求「覆盖率数字」。只报：改坏哪一处，现有测试不会失败`,
  },

  // 【什么时候必须加】同一个需求改了多处 · 新功能是照着已有功能做的 · 多人分头实现同一类页面
  //   它查的不是"重复代码"(那是 dead-code / simplify 维度),是"同一件事被写成了多种样子"
  'reuse-consistency': {
    key: 'reuse-consistency',
    role: '复用与一致性审查员。找**同一件事被写成了多种样子**，不找缺陷、也不找内部风格偏好',
    focus: `- 同一个需求在多处实现时，**用户看得见的那一层是否一致**：按钮主次与颜色、文案、位置、
  交互方式、确认框有无、报错提示措辞。判据是"这几处用户看到的是不是同一个东西"
- 新功能是不是照着已有的同款功能搬的？还是无理由地另起了一套命名/结构/数据流/模板写法
- 同一类操作出现多种写法：一处硬列选项、另一处数组渲染；一处走封装、另一处直接裸调
- 同名或同义的字段、事件名、常量，在不同文件里含义或取值不一致
- 已有可复用实现却另写了一份——**不是逐字重复，是"看得出是同一件事"却各写各的**
- 局部先例自相矛盾时（同一文件两种写法混着）：按**语义**定而不是抄最近的邻居（如主动作用主色、辅助/取消用默认样式）
- fix 里要指定**基准实现**：以最老的、人工手写的原始代码为准；**AI 生成的代码不作风格权威**
- ⚠️ 排除项：变量命名、缩进、文件内部结构这些**用户看不见**的差异，各随各文件的既有习惯，不报`,
  },
}

// 自定义维度只需给 {key, role, focus}，CONTEXT 由这里统一拼上，不会漏
const 选用 = [...new Set(P.extraDims || [])].map((n) => {
  const d = EXTRA_DIMS[n]
  // 名字拼错要炸，不能静默少跑一个维度——尤其 security 是准入维度，静默漏掉最危险
  if (!d) throw new Error(`args.extraDims 里的 "${n}" 不是可选维度。可选：${Object.keys(EXTRA_DIMS).join(' / ')}`)
  return d
})
// only/skip 的名字拼错同样要炸：静默少跑一个维度，比报错更糟
const 校验键 = (arr, 名) => (arr || []).forEach((k) => {
  if (!DEFAULT_DIMS.some((d) => d.key === k)) {
    throw new Error(`args.${名} 里的 "${k}" 不是默认维度。可选：${DEFAULT_DIMS.map((d) => d.key).join(' / ')}`)
  }
})
校验键(P.only, 'only'); 校验键(P.skip, 'skip')
if (P.inject) Object.keys(P.inject).forEach((k) => { if (!Array.isArray(P.inject[k])) throw new Error(`args.inject.${k} 必须是发现数组`) })
if (P.diffBase && !/^(?!-)[\w./@^~+-]+$/.test(String(P.diffBase))) throw new Error(`args.diffBase 含非法字符（会被拼进 git 命令）：${P.diffBase}`)
if (P.dims) {
  const seen = new Set()
  P.dims.forEach((d, i) => {
    if (!d || !d.key || !d.role || !d.focus) throw new Error(`args.dims[${i}] 必须有 key / role / focus`)
    if (d.kind && !['缺陷', '精简'].includes(d.kind)) throw new Error(`args.dims[${i}].kind 只能是「缺陷」或「精简」，收到 "${d.kind}"`)
    if (seen.has(d.key)) throw new Error(`args.dims 里 key "${d.key}" 重复（key 用来匹配结果，必须唯一）`)
    seen.add(d.key)
  })
}
if (P.mode && P.mode !== 'cleanup') throw new Error(`args.mode 只支持 'cleanup'，收到 "${P.mode}"`)
const ONLY = P.only || (P.mode === 'cleanup' ? ['dead-code', 'simplify'] : null)
const 默认选中 = DEFAULT_DIMS
  .filter((d) => !ONLY || ONLY.includes(d.key))
  .filter((d) => !(P.skip || []).includes(d.key))
const 维度源 = P.dims || [...默认选中, ...选用]
const 分区们 = Object.entries(PATHS)
// 分片：大仓库一个找手读不完全部路径，会越读越浅。每个维度按分区各起一个找手，
// 验证员仍按「分区内的发现」分批。代价：agent 数 = 维度数 × 分区数 × 2，成本成倍，所以必须显式 shard:true
// inject 的 key 必须对得上本轮真的会跑的维度，否则会被静默忽略、同时白起一个真找手（既花钱又不是你想测的）
if (P.inject) {
  const 本轮 = new Set(维度源.map((d) => d.key))
  Object.keys(P.inject).forEach((k) => { if (!本轮.has(k)) throw new Error(`args.inject 里的 "${k}" 不在本轮维度里（本轮：${[...本轮].join(', ')}），会被静默忽略`) })
  if (P.shard) throw new Error('args.inject 不能和 args.shard 同时用（注入的发现按维度 key 对应，分片后 key 变成「维度@分区」）')
  Object.entries(P.inject).forEach(([k, arr]) => arr.forEach((f, i) => {
    const 缺 = ['title', 'file', 'evidence', 'failure', 'fix', 'severity'].filter((x) => !f || !f[x])
    if (缺.length || !Number.isInteger(f.line)) throw new Error(`args.inject.${k}[${i}] 缺字段：${[...缺, ...(Number.isInteger(f && f.line) ? [] : ['line(整数)'])].join(' / ')}`)
  }))
}
const 展开 = P.shard && 分区们.length > 1
  ? 维度源.flatMap((d) => 分区们.map(([名, 路径]) => ({ ...d, base: d.key, key: `${d.key}@${名}`, part: { 名, 路径 } })))
  : 维度源.map((d) => ({ ...d, base: d.key }))
if (P.shard && 分区们.length <= 1) log('args.shard 只有一个 paths 分区，不分片')
const DIMS = 展开.map((d) => {
  const kind = d.kind || '缺陷'
  const cap = CAP[kind]
  return {
    key: d.key, base: d.base, kind, cap,
    prompt: `你是${d.role}。
${CONTEXT}
${d.part ? `# 本分片（重要）\n你只负责分区「${d.part.名}」：${d.part.路径}。**只报这个分区里的问题**；\n查调用方/引用时可以读其他分区，但问题本身必须落在本分区的文件上。其他分区由别的审查员负责。\n` : ''}
${kind === '精简' ? OUT_CLEAN : OUT_BUG}

重点看这些地方（先读代码再下结论）：
${d.focus}
逐个核实后再报。最多 ${cap} 条——**若你找到的超过 ${cap} 条，报最值得处理的 ${cap} 条，并把多出来的条数写进 suppressed 字段**。`,
  }
})

if (!DIMS.length) throw new Error('筛完一个维度都不剩（only/skip/extraDims 的组合把它们都排除了），已中止')
log(`本轮 ${DIMS.length} 个维度 ≥ ${DIMS.length * 2} 个 agent（找手+验证员；精简类发现多时验证员会分批，更多）≈ ${DIMS.length * 10}（小项目）~ ${DIMS.length * 20}（大项目）万 token：${DIMS.map((d) => d.key).join(', ')}`)

// 验证员判据：两类发现的「成立」含义相反，必须分开写，否则精简类会被缺陷类的标准全部毙掉
const 判据缺陷 = `【kind=缺陷 的判法】
- 只有当你**亲自读到那些行**、并且能推演出声称的失败场景确实会发生 → **成立**
- 代码里已有别的机制挡住了该场景 → **不成立**
- 属于**设计如此/文档化的允许行为**，并不是 bug → **不成立**（先确认那个"异常"到底是不是 bug）
- 推演不够时可以用**只读**命令实测：静态检查器、grep、在内存/临时环境里跑最小复现。
  **不得有副作用、不得连生产、不得改任何被审文件**；跑了就在 reason 里写明命令和结果
- 属于"为不可能的场景担心" → **不成立**
- 纯风格/口味问题 → **不成立**。
  ⚠️ 但**跨文件的"用户可见不一致"不算纯风格**：同一个操作在两个页面按钮颜色/主次不同、
  文案不同、交互不同——用户会以为是两个不同功能。说得清"用户会怎么被误导"就是**成立**。
  只有缩进/引号/变量命名/内部结构这种用户看不见的差异才算风格。
- 描述有小错但问题实际成立 → **成立**，并在 correction 里写出准确描述；行号有偏差就填 **correctedLine**`

const 判据精简 = `【kind=精简 的判法】（死代码/冗余/过度设计：没有失败场景是正常的，**不要**拿"推演不出失败场景"当不成立的理由，
也不要因为"它不会出错/只是风格"就否掉——整理代码、提高可维护性正是本轮目的）
你的任务是**证伪「它可以删/可以简化」**：去找一个**活的引用**或**行为差异**。
1. 你必须**自己**做消费方搜索，不要采信找手写的 impact：对被删/被改的每个符号做带符号名的全仓搜索
   （rg，不加文件后缀过滤；命中 0 时先自检过滤器再下结论），再查动态引用：字符串拼接名、反射/getattr、
   路由/配置/DI/模板/序列化里按名字引用、测试、对外导出的公共 API。
   把「搜了什么 → 命中什么 → 结论」写进 **impactChecked**（必填）。
2. 找到活引用，或删/改后行为会变 → **不成立**，reason 写明引用在哪
3. 是「让常见情况成功」的处理（如剥掉 \`\`\`json 包裹）→ **不成立**
4. 简化类：能写出**行为等价**的依据 → **成立**。找手给的替换写法与原行为有差异时分三种，别一律否掉：
   - 简化的方向是对的，且存在**行为等价的更保守写法**（如保留 .get 默认值、只删确实走不到的分支）→ **成立**，把等价写法写进 correction
   - 等价与否取决于**你读不到的东西**（上游数据形状、外部库、运行时配置）→ **读不出结论**，写清卡在哪，不要压成不成立
   - 你能**指出一个具体的输入**，使两种写法结果不同，并且找不到任何等价的简化 → **不成立**，写出那个输入
5. 所有引用都已搜清、确实没有活引用（死代码），或简化后确实等价 → **成立**；
   把更准确的行号/连带孤儿/行数写进 correction（找手漏列的连带孤儿尤其要补）
6. 无法排除动态引用/对外 API/跨仓库调用 → **读不出结论**，在 reason 里写清卡在哪，
   不要压成「不成立」——它是「不确定能不能删」，要留给人决定
7. 找手贴的代码必须能在真实文件里逐字找到；找不到 → **不成立**，写明"证据在文件中不存在"
8. 行号偏差不算否掉的理由：同一文件邻近位置能找到就算数，真实起始行号填 **correctedLine**，其余写进 correction`

const 验证一批 = (d, 批, 偏移) => {
  const numbered = 批
    .map((f, i) => `【${i + 1}】[kind=${f.kind || d.kind}] ${f.title}
  文件: ${f.file}:${f.line}
  证据: ${f.evidence}
  ${f.kind === '精简' ? '留着的代价' : '声称的失败场景'}: ${f.failure}
  ${f.kind === '精简' ? '找手声称的影响面(仅供参考，必须自己重查)' : '影响面'}: ${f.impact || '(未写)'}
  建议改法: ${f.fix}
  自评严重度: ${f.severity}`)
    .join('\n\n')
  const 含精简 = 批.some((f) => (f.kind || d.kind) === '精简')
  const 含缺陷 = 批.some((f) => (f.kind || d.kind) === '缺陷')
  return agent(
    `你是对抗性验证员，任务是**尽力证伪**下面这些声称的问题。默认立场：不成立。
${CONTEXT}
下面是另一个审查员报的 ${批.length} 条，逐条打开对应文件核实。每条标了 kind，**按各自的判法**：

${numbered}

${含缺陷 ? 判据缺陷 + '\n\n' : ''}${含精简 ? 判据精简 + '\n\n' : ''}通用：
- **读了相关代码，但证据不足以判断**（缺上下文、依赖运行时配置、要跨仓库才能确认）→ **读不出结论**，
  并在 reason 里写清卡在哪。**不要把这种情况压成"不成立"**——压了就会和真正的假阳性混在一起，人工抽查时无从下手。
- 上面的"证据"是另一个 agent 写的，**可能是它编的**。
对每一条给出 verdict（三选一），并在 index 里写它的序号（就是上面【】里的数字）。
必须对上面每一条都给出判定，一条不落。`,
    { label: `verify:${d.key}${偏移 ? `#${偏移 / 验证批量 + 1}` : ''}`, phase: 'Verify', schema: VERDICT, effort: 'high' },
  ).then((v) => {
    const 收 = new Map()
    for (const x of (v && v.verdicts) || []) {
      // 越界的 index（<1 或 >本批条数）不属于这一批，丢掉，否则偏移后会撞上别的批次、盖掉真判定
      if (!Number.isInteger(x.index) || x.index < 1 || x.index > 批.length) continue
      // 同一 index 给了两次：不静默取第一个。判定一致就留一个，不一致就标「读不出结论」交给人
      const 旧 = 收.get(x.index)
      收.set(x.index, !旧 ? x : (旧.verdict === x.verdict ? 旧 : { ...旧, verdict: '读不出结论', reason: `验证员对同一条给了互相矛盾的判定（${旧.verdict} / ${x.verdict}）` }))
    }
    return [...收.values()].map((x) => ({ ...x, index: x.index + 偏移 }))
  })
   .catch((e) => { log(`⚠️ 验证员 ${d.key}${偏移 ? `#${偏移 / 验证批量 + 1}` : ''} 出错：${String(e && e.message || e).slice(0, 120)}——这一批落入「未判定」`); return [] })   // 验证员挂了：这一批落入「未判定」，不丢找手的发现
}
// 精简类每条都要自己搜全仓，一个验证员塞太多会越查越浅，所以分批
const 验证批量 = 8

// ── 编排：每个维度独立流水线(找→验)，维度之间不设栅栏 ────────────────
phase('Find')
const results = await pipeline(
  DIMS,
  (d) => (P.inject && P.inject[d.key])
    ? { findings: P.inject[d.key], suppressed: 0 }   // 注入的发现：跳过找手，直接进验证
    : agent(d.prompt, { label: `find:${d.key}`, phase: 'Find', schema: findingsSchema(d.cap) }),
  async (found, d) => {
    // found 为空 = 找手没返回，**不是**「这个维度干净」。必须单独标出来，否则 0 条会被读成没问题
    if (!found || !Array.isArray(found.findings)) {
      return { key: d.key, base: d.base, findings: [], verdicts: [], suppressed: 0, finderFailed: true }
    }
    const list = found.findings.map((f) => ({ ...f, kind: ['缺陷', '精简'].includes(f.kind) ? f.kind : d.kind }))
    const suppressed = found.suppressed || 0
    if (!list.length) return { key: d.key, base: d.base, findings: [], verdicts: [], suppressed }
    const 批们 = []
    for (let i = 0; i < list.length; i += 验证批量) 批们.push([list.slice(i, i + 验证批量), i])
    const 各批 = await Promise.all(批们.map(([批, 偏移]) => 验证一批(d, 批, 偏移)))
    return { key: d.key, base: d.base, findings: list, verdicts: 各批.flat(), suppressed }
  },
)

// ── 汇总：按 index 回填判定 ─────────────────────────────────────────
phase('Synthesize')
const rs = results.filter(Boolean)
// pipeline 里整条流水线抛错会变成 null/缺位：同样不能当成「干净」
const 失败维度 = [
  ...rs.filter((r) => r.finderFailed).map((r) => r.key),
  ...DIMS.filter((d) => !rs.some((r) => r.key === d.key)).map((d) => d.key),
]

// 严重度归一：验证员/找手即使写了「C」「C级」「低」，也必须落进某个分组，不能让发现因为写法不规范而从正文消失。
// 先认开头的 A/B/C 字母（「C-建议（不严重）」里的「严重」不能把它判成 A），没有字母才按中文关键词
const 归一 = (v) => {
  const t = String(v || '').trim()
  if (!t) return null
  const 首 = /^([ABC])(?![a-z])/i.exec(t)
  if (首) return { A: 'A-阻断', B: 'B-重要', C: 'C-建议' }[首[1].toUpperCase()]
  if (/建议|轻微|低/.test(t)) return 'C-建议'
  if (/阻断|致命|严重/.test(t)) return 'A-阻断'
  if (/重要|中/.test(t)) return 'B-重要'
  return null
}
const 等级 = (m) => m.levelOverride || 归一(m.severityAdjusted) || 归一(m.severity) || '未分级'
const 分级 = ['A-阻断', 'B-重要', 'C-建议', '未分级']
const 更严 = (x, y) => 分级.indexOf(x) <= 分级.indexOf(y) ? x : y   // 未分级排最后，所以有等级的永远比未分级「更严」

// 路径规范化：找手有时写绝对路径、有时写相对路径（真实运行里同一轮就是 29 条绝对 / 11 条相对），
// 去重按字符串比较就会漏；绝对路径还会把临时副本的完整路径带进报告。统一成「分区名/分区内相对路径」
const 规范文件 = (f) => {
  const t = String(f || '')
  for (const [名, 路径] of [...分区们].sort((x, y) => String(y[1]).length - String(x[1]).length)) {   // 嵌套分区取最长前缀
    const base = String(路径).replace(/\/+$/, '')
    if (t === base || t.startsWith(base + '/')) return `${名}/${t.slice(base.length).replace(/^\//, '')}`
  }
  const rel = t.replace(/^\.\//, '')
  // 只有一个分区时，相对路径必然在这个分区里，补上前缀才能和绝对路径写法对上；多分区时无法判断，保持原样
  if (分区们.length === 1 && rel && !rel.startsWith('/') && !rel.startsWith(分区们[0][0] + '/')) return `${分区们[0][0]}/${rel}`
  return rel
}

// 同一个文件？绝对/相对、`git diff` 给的仓库相对路径、多分区下没法补前缀的写法，都靠「去掉分区前缀后后缀对得上」来判断
const 去分区 = (f) => { const i = f.indexOf('/'); return i > 0 && 分区们.some(([名]) => 名 === f.slice(0, i)) ? f.slice(i + 1) : f }
const 同文件 = (x, y) => {
  if (x === y) return true
  const a = 去分区(x), b = 去分区(y)
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
}

const merged = []
for (const r of rs) {
  r.findings.forEach((f, i) => {
    const v = r.verdicts.find((x) => x.index === i + 1)
    let verdict = v ? v.verdict : '未拿到判定'
    let reason = v ? v.reason : '验证员没返回这一条'
    // 判定不在三态里（比如「成立（部分）」）：不能让它掉出所有桶。当作「读不出结论」，由人看
    if (v && !['成立', '不成立', '读不出结论'].includes(verdict)) {
      reason = `验证员给了无法识别的判定「${verdict}」，按「读不出结论」处理。${reason}`
      verdict = '读不出结论'
    }
    // 精简类的「成立」必须带验证员自己做的影响面搜索；没写等于没查，降级，不能当「可以删」
    if (f.kind === '精简' && verdict === '成立' && !(v.impactChecked || '').trim()) {
      verdict = '读不出结论'
      reason = `验证员判了成立但没写 impactChecked（没有自己做影响面搜索），不能直接当"可以删"。${reason}`
    }
    merged.push({
      dim: r.base, shard: r.key !== r.base ? r.key : undefined, ...f, file: 规范文件(f.file),
      // 验证员给了真实行号就以它为准，报告里的 文件:行号 才可点、才对得上
      line: (v && v.correctedLine) || f.line,
      verdict, verifyReason: reason,
      correction: v && v.correction,
      severityAdjusted: v && v.severityAdjusted,
      impactChecked: v && v.impactChecked,
    })
  })
}

// 跨维度去重：同类、同文件、**同一行**才合并（真实运行里 6 对合并全是同一行；相差 1~3 行的可能是两个不同的问题，
// 比如一个 SQL 注入紧挨着一个竞态，合并会让其中一个整条消失，所以相邻行不合并）。
// 代表条取「判定最好」的（成立 > 读不出结论 > 未判定 > 不成立），否则先出现的不成立会吞掉后出现的成立。
// 败者的信息不丢：标题进 alsoFoundBy，严重度取更严的，needsDecision 取并集。判定冲突不替人选，原样列出
const 判定优先 = { '成立': 3, '读不出结论': 2, '未拿到判定': 1, '不成立': 0 }
const 去重 = []
for (const m of merged) {
  const i = 去重.findIndex((x) => x.kind === m.kind && x.dim !== m.dim && 同文件(x.file, m.file) && (x.line || 0) === (m.line || 0))
  if (i < 0) { 去重.push(m); continue }
  const dup = 去重[i]
  const [留, 并] = (判定优先[m.verdict] ?? 0) > (判定优先[dup.verdict] ?? 0) ? [m, dup] : [dup, m]
  const tags = [...(dup.alsoFoundBy || []), `${并.dim}（${并.verdict}）「${并.title}」`]
  去重[i] = {
    ...留,
    alsoFoundBy: [...new Set(tags)],
    levelOverride: (留.verdict === '成立' && 并.verdict === '成立') ? 更严(等级(留), 等级(并)) : 留.levelOverride,
    needsDecision: 留.needsDecision || (并.verdict === '成立' ? 并.needsDecision : undefined),
  }
}

// 四个桶，不是三个：「读不出结论」是验证员读了但判不了，「未判定」是压根没返回。
// 两者都不等于"没问题"，但卡住的原因不同，处理方式也不同
const 成立   = 去重.filter((m) => m.verdict === '成立')
// 缺陷与精简分开呈现：精简类是一份**整理清单**（用户据此删代码、简化代码），不与缺陷修复混在一起
const 确认   = 成立.filter((m) => m.kind !== '精简')
const 整理   = 成立.filter((m) => m.kind === '精简')
// 按发现的性质分桶（cleanupType），不按它是哪个维度报的——死代码维度也会报「留着但该简化」的
const 是删除 = (m) => (m.cleanupType ? /^删除/.test(m.cleanupType) : m.dim === 'dead-code')
const 可删   = 整理.filter(是删除)
const 可简化 = 整理.filter((m) => !是删除(m))
const 按收益 = (a, b) => (b.linesSaved || 0) - (a.linesSaved || 0)
const 需拍板 = 成立.filter((m) => m.needsDecision)
const 证伪   = 去重.filter((m) => m.verdict === '不成立')
const 存疑   = 去重.filter((m) => m.verdict === '读不出结论')
const 未判定 = 去重.filter((m) => m.verdict === '未拿到判定')
const 被截断 = rs.reduce((n, r) => n + (r.suppressed || 0), 0)
const 总行数 = 整理.reduce((n, m) => n + (m.linesSaved || 0), 0)

// 候选 known：把本轮每个成立/存疑的发现列成一行，用户把「决定保持现状」或「已修掉」的几行复制进下一轮 args.known，
// 下一轮就不会再报一遍。不替用户判断哪些该进——只负责把格式化好的候选列出来
const 候选known = [
  ...成立.map((m) => `${m.title}（${m.file}）`),
  ...存疑.map((m) => `${m.title}（${m.file}）`),
  // 已核实不成立的也列出来：下一轮不写进 known，找手会再报一遍、验证员再白验一遍
  ...证伪.map((m) => `${m.title}（${m.file}）——上轮已核实不成立`),
]

log(`找到 ${merged.length} 条（去重后 ${去重.length}）：缺陷确认 ${确认.length}；可删 ${可删.length}、可简化 ${可简化.length}（预计净减 ${总行数} 行）；需拍板 ${需拍板.length}；证伪 ${证伪.length}，存疑 ${存疑.length}，未判定 ${未判定.length}`)
if (失败维度.length) log(`❌ 维度 ${失败维度.join(', ')} 的找手没有返回——这些维度**没审**，0 条不代表干净，需要重跑`)
if (存疑.length) log(`⚠️ ${存疑.length} 条「读不出结论」——人工复核第一优先级（其中精简类多半是"无法排除动态引用/对外 API"，不是"不能删"）`)
if (未判定.length) log(`⚠️ ${未判定.length} 条没拿到判定，去 journal.jsonl 核原始返回值，不要当成"没问题"`)
if (被截断) log(`⚠️ 另有 ${被截断} 条因每维度上限没报上来（缺陷 ${CAP.缺陷} / 精简 ${CAP.精简}）。要拿全就加 args.shard（按 paths 分区各起一个找手）或把 paths 拆细再跑一轮`)

// 现成的 markdown 报告：脚本里没有写文件的能力，由调用方（SKILL.md 步骤 3）把它落盘，再据此出修改方案
const 条目 = (m) => `- **[${等级(m)}${m.severityAdjusted && 归一(m.severityAdjusted) !== 归一(m.severity) ? `，验证员由 ${m.severity} 调整` : ''}] ${m.title}** — \`${m.file}:${m.line}\`（${m.dim}${m.alsoFoundBy ? `；另被 ${m.alsoFoundBy.join('、')} 报出` : ''}）
  - 失败场景：${m.failure}
  - 验证：${m.verifyReason}${m.correction ? `\n  - 修正：${m.correction}` : ''}
  - 最简修法：${m.fix}${m.alternatives ? `\n  - 其他改法与取舍：${m.alternatives}` : ''}${m.impact ? `\n  - 影响面：${m.impact}` : ''}${m.needsDecision ? `\n  - ⚠️ 需人拍板：${m.needsDecision}` : ''}`
// 整理清单每条自带：为什么留着有害 / 影响面（验证员自己搜的结果）/ 怎么删怎么改 / 风险，用户看这一条就能决定删不删
const 整理条目 = (m) => `- **${m.title}** — \`${m.file}:${m.line}\`${m.linesSaved ? `　预计净减 ${m.linesSaved} 行` : ''}（${m.dim}${m.alsoFoundBy ? `；另被 ${m.alsoFoundBy.join('、')} 报出` : ''}）
  - 留着的代价：${m.failure}
  - 影响面（验证员实查）：${m.impactChecked || '(未写)'}
  - 怎么做：${m.correction ? `${m.fix}\n  - 验证员补充：${m.correction}` : m.fix}${m.alternatives ? `\n  - 其他做法与取舍：${m.alternatives}` : ''}
  - 风险：${m.risk || '(未写)'}${m.needsDecision ? `\n  - ⚠️ 需人拍板：${m.needsDecision}` : ''}`


const 报告 = [
  `# 代码审查报告`,
  `维度：${[...new Set(DIMS.map((d) => d.base))].join(', ')}${P.shard ? `（按 ${分区们.length} 个分区分片）` : ''}${P.diffBase ? `；范围：diff ${P.diffBase}...HEAD` : ''}`,
  失败维度.length ? `\n> ❌ 未审成：${失败维度.join(', ')}（找手无返回，0 条≠干净）` : '',
  被截断 ? `> ⚠️ 被截断 ${被截断} 条，本轮没报全` : '',
  // 需要人拍板的单独拎到最前面，别埋在一大段里被「顺手一起同意」
  需拍板.length ? `\n## ⚠️ 需你拍板（${需拍板.length}）\n${需拍板.map((m) => `- **${m.title}** — \`${m.file}:${m.line}\`：${m.needsDecision}${m.alternatives ? `（可选做法：${m.alternatives}）` : ''}`).join('\n')}` : '',
  `\n## 缺陷（${确认.length}）`,
  ...分级.map((lv) => {
    const xs = 确认.filter((m) => 等级(m) === lv)
    return xs.length ? `\n### ${lv}\n${xs.map(条目).join('\n')}` : ''
  }),
  `\n## 整理清单·可删除的代码（${可删.length}）`,
  `> 影响面已由验证员独立搜索确认；按预计净减行数从多到少排。建议**单独成一次提交**，不与缺陷修复混在一起。`,
  ...可删.sort(按收益).map(整理条目),
  `\n## 整理清单·可简化的过度设计（${可简化.length}）`,
  ...可简化.sort(按收益).map(整理条目),
  整理.length ? `\n> 整理清单合计预计净减约 ${总行数} 行。` : '',
  `\n## 存疑·人工复核第一优先（${存疑.length}）`,
  ...存疑.map((m) => `- [${m.kind}] ${m.title} — \`${m.file}:${m.line}\`（${m.dim}${m.alsoFoundBy ? `；另被 ${m.alsoFoundBy.join('、')} 报出` : ''}）\n  - 卡在：${m.verifyReason}\n  - 声称的问题：${m.failure}\n  - 建议做法：${m.fix}${m.needsDecision ? `\n  - ⚠️ 需人拍板：${m.needsDecision}` : ''}`),
  `\n## 未判定·去 journal.jsonl 核（${未判定.length}）`,
  ...未判定.map((m) => `- [${m.kind}] ${m.title} — \`${m.file}:${m.line}\`（${m.dim}）\n  - 声称的问题：${m.failure}\n  - 建议做法：${m.fix}`),
  `\n## 证伪·抽查（${证伪.length}）`,
  ...证伪.map((m) => `- [${m.kind}] ${m.title} — \`${m.file}:${m.line}\`（${m.dim}${m.alsoFoundBy ? `；另被 ${m.alsoFoundBy.join('、')} 报出` : ''}）— ${m.verifyReason}`),
  候选known.length ? `\n## 候选 known（决定「保持现状」或「已修」的，复制进下一轮 args.known，别再被重复报）\n${候选known.map((k) => `- ${k}`).join('\n')}` : '',
].filter((x) => x !== '').join('\n')

return {
  报告,
  确认,
  可删,
  可简化,
  存疑: 存疑.map((r) => ({ dim: r.dim, kind: r.kind, title: r.title, file: r.file, line: r.line, 卡在哪: r.verifyReason, 声称的问题: r.failure, 建议做法: r.fix, 需拍板: r.needsDecision })),
  证伪: 证伪.map((r) => ({ dim: r.dim, kind: r.kind, title: r.title, file: r.file, line: r.line, 为何否掉: r.verifyReason })),
  未判定,
  被截断,
  失败维度,
  候选known,
}
