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
//   known      string[]                        已知问题（extraKnown 是同义旧名，仍可用）
//   only       string[]                        只跑这些默认维度，如 ['backend-bugs']（成本表的「轻量/标准」就靠它）
//   skip       string[]                        跳过这些默认维度
//   extraDims  string[]                        追加可选维度：'security' / 'reuse-consistency' / 'llm-async'
//   dims       [{key,role,focus}]              完全自定义，传了就只跑它们
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
const 占位 = (v) => typeof v === 'string' && v.includes('【')
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
const KNOWN = [
  '【按项目填:上一轮已确认或已拍板不改的问题，一行一条。首次跑可留空数组】',
  ...(P.known || []),
  ...(P.extraKnown || []),
].filter((k) => !占位(k))

const CONTEXT = `${PROJECT}

# 已经找过、不要重复报告的问题
${KNOWN.map((k) => `- ${k}`).join('\n')}

# 输出要求
只报你能在代码里指出具体行、并说清"什么输入/什么时序会出错"的问题。
宁缺毋滥：拿不准的不要报。不要报纯风格问题，不要报上面已列出的。
注意：**缩进/引号/命名/内部结构的差异 = 纯风格，不报**；但**同一个操作在不同页面
呈现给用户的样子不一致（按钮主次或颜色、文案、位置、交互、报错提示）不是风格问题**，
它是用户能看见的缺陷，该报。
`

const FINDINGS = {
  type: 'object',
  required: ['findings', 'suppressed'],
  properties: {
    // 8 条是硬上限。超了必须在 suppressed 里报数，否则被砍掉的条目无声消失
    suppressed: { type: 'integer', description: '你实际找到、但因 8 条上限没报上来的条数。没有就填 0' },
    findings: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['title', 'file', 'line', 'evidence', 'failure', 'fix', 'severity'],
        properties: {
          title:    { type: 'string', description: '一句话说清问题' },
          file:     { type: 'string' },
          line:     { type: 'integer' },
          evidence: { type: 'string', description: '贴出关键代码，说明为什么是问题' },
          // 这个字段是判真假的唯一依据，逼 agent 从"我觉得不好"变成"这样点会出错"
          failure:  { type: 'string', description: '具体失败场景：什么输入/什么时序 → 什么错误结果' },
          fix:      { type: 'string', description: '最简修法：只写必要那几行，匹配周围既有风格，不顺手重构、不加当前环境走不到的兜底' },
          // 下面四个可选字段对应修改方案：并列改法 / 影响面 / 拍板 / 既有代码，缺了方案就只能靠主会话临时补
          alternatives:  { type: 'string', description: '若存在不止一种合理改法，并列写出其他改法与取舍；只有一种就留空。不要静默替用户选' },
          impact:        { type: 'string', description: '改这里会动到别人依赖的什么（签名/返回结构/字段/共享常量），以及你搜到的消费方；形状没变就留空' },
          needsDecision: { type: 'string', description: '需要人拍板才能改的原因（改表/产品语义/成本策略/抽公共模块/为性能牺牲简洁）；不需要就留空' },
          preexisting:   { type: 'boolean', description: '问题是否在本次改动之前就存在（仅在限定了审查范围为 diff 时有意义；其他情况可省）' },
          severity: { type: 'string', enum: ['A-阻断', 'B-重要', 'C-建议'] },
        },
      },
    },
  },
}

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
            description: '能推演出失败场景=成立；确认被挡住/不可能/纯内部风格=不成立；读了但证据不足以判定=读不出结论',
          },
          reason: { type: 'string', description: '你读了哪些行、为什么确认或否掉' },
          correction:       { type: 'string', description: '若原描述(含行号)有误但问题仍成立，写出准确描述' },
          severityAdjusted: { type: 'string' },
        },
      },
    },
  },
}

// ── ④ 审查维度。下面四个是**示例**：前两个假设了「关系型库+ORM+事务」的后端
//    和「SPA 组件生命周期+轮询」的前端。换技术栈时**替换 focus 里的重点清单**，
//    否则该维度会整段空转。第 3、4 个维度基本与栈无关，建议保留。
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
    key: 'dead-code-overdesign',
    role: '冗余与过度设计审查员。找**不该存在的代码**，不找缺陷',
    focus: `- 未被任何地方引用的函数/路由/组件/导出/样式类
- 只剩一个调用方、或整个模块只为一个两行函数存在的间接层
- 同一逻辑的多份实现（含逐字复制的分支），以及它们已经漂移出的差异
- **当前环境永远走不到的分支**：为不可能的场景写的降级/兼容/兜底
- 为假设需求预留、至今没有使用者的抽象与配置项
- 触发点已被注释掉/删除，但下游整条链路还留着的"死链路"
- 注释与代码不符（注释描述的是旧行为）
- 本次联调遗留的临时 console.log / 观测日志
- ⚠️ 排除项：**为"让常见情况成功"而写的处理要留**（如解析模型输出前剥掉 \`\`\`json 包裹——模型高频加、不剥会真失败）。
  只有"防不可能发生的情形 / 已被外层兜住"的才算冗余。拿不准就别报
- ⚠️ 既有的无关死代码也可以报，但**必须标 preexisting=true**：它不进本次改动，只作"建议清理"提醒`,
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
//      a) 起工作流时传 args.extraDims: ['security'](在默认四个维度之外**追加**)
//      b) 改这个文件:把 EXTRA_DIMS.security 写进 DEFAULT_DIMS
//    (args.dims 是另一回事:传了它就**只跑你传的那些**,默认四个和这里的都不参与)
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

  // 【什么时候必须加】同一个需求改了多处 · 新功能是照着已有功能做的 · 多人分头实现同一类页面
  //   它查的不是"重复代码"(那是 dead-code-overdesign),是"同一件事被写成了多种样子"
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
const 选用 = (P.extraDims || []).map((n) => {
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
const 默认选中 = DEFAULT_DIMS
  .filter((d) => !P.only || P.only.includes(d.key))
  .filter((d) => !(P.skip || []).includes(d.key))
const DIMS = (P.dims || [...默认选中, ...选用]).map((d) => ({
  key: d.key,
  prompt: `你是${d.role}。
${CONTEXT}
重点看这些地方（先读代码再下结论）：
${d.focus}
逐个核实后再报。最多 8 条——**若你找到的超过 8 条，报最严重的 8 条，并把多出来的条数写进 suppressed 字段**。`,
}))

if (!DIMS.length) throw new Error('筛完一个维度都不剩（only/skip/extraDims 的组合把它们都排除了），已中止')
log(`本轮 ${DIMS.length} 个维度 = ${DIMS.length * 2} 个 agent（找手+验证员）≈ ${DIMS.length * 20} 万 token：${DIMS.map((d) => d.key).join(', ')}`)

// ── 编排：每个维度独立流水线(找→验)，维度之间不设栅栏 ────────────────
phase('Find')
const results = await pipeline(
  DIMS,
  (d) => agent(d.prompt, { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS }),
  (found, d) => {
    // found 为空 = 找手没返回，**不是**「这个维度干净」。必须单独标出来，否则 0 条会被读成没问题
    if (!found || !Array.isArray(found.findings)) {
      return { key: d.key, findings: [], verdicts: [], suppressed: 0, finderFailed: true }
    }
    const list = found.findings
    const suppressed = found.suppressed || 0
    if (!list.length) return { key: d.key, findings: [], verdicts: [], suppressed }
    const numbered = list
      .map((f, i) => `【${i + 1}】${f.title}
  文件: ${f.file}:${f.line}
  证据: ${f.evidence}
  声称的失败场景: ${f.failure}
  建议修法: ${f.fix}
  自评严重度: ${f.severity}`)
      .join('\n\n')
    return agent(
      `你是对抗性验证员，任务是**尽力证伪**下面这些声称的问题。默认立场：不成立。
${CONTEXT}
下面是另一个审查员报的 ${list.length} 条问题，逐条打开对应文件核实：

${numbered}

对每一条给出 verdict（三选一），并在 index 里写它的序号：
- 只有当你**亲自读到那些行**、并且能推演出声称的失败场景确实会发生 → **成立**
- **行号偏差不算否掉的理由**：按行号打开后，若在同一文件邻近位置能找到声称的代码，
  仍判成立，把真实行号写进 correction。
  ⚠️ 上面那段"证据"是另一个 agent 写的，**可能是它编的**——贴出来的代码必须能在真实文件里
  逐字找到。整个文件里都找不到 → **不成立**，并在 reason 里写明"证据在文件中不存在"。
- 代码里已有别的机制挡住了该场景 → **不成立**
- 属于**设计如此/文档化的允许行为**，并不是 bug → **不成立**（先确认那个"异常"到底是不是 bug）
- 推演不够时可以用**只读**命令实测：静态检查器、grep、在内存/临时环境里跑最小复现。
  **不得有副作用、不得连生产、不得改任何被审文件**；跑了就在 reason 里写明命令和结果
- 属于"为不可能的场景担心" → **不成立**
- 纯风格/口味问题 → **不成立**。
  ⚠️ 但**跨文件的"用户可见不一致"不算纯风格**：同一个操作在两个页面按钮颜色/主次不同、
  文案不同、交互不同——用户会以为是两个不同功能。这类要按能否说清"用户会怎么被误导"来判，
  说得清就是**成立**。只有缩进/引号/变量命名/内部结构这种用户看不见的差异才算风格。
- 描述有小错但问题实际成立 → **成立**，并在 correction 里写出准确描述
- **读了相关代码，但证据不足以判断它到底会不会发生**（缺上下文、依赖运行时配置、
  要跨仓库才能确认）→ **读不出结论**，并在 reason 里写清卡在哪。
  **不要把这种情况压成"不成立"**——压了就会和真正的假阳性混在一起，人工抽查时无从下手。
必须对上面每一条都给出判定，一条不落。`,
      { label: `verify:${d.key}`, phase: 'Verify', schema: VERDICT, effort: 'high' },
    ).then((v) => ({ key: d.key, findings: list, verdicts: (v && v.verdicts) || [], suppressed }))
     .catch(() => ({ key: d.key, findings: list, verdicts: [], suppressed }))  // 验证员挂了：落入「未判定」，不丢找手的发现
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

const merged = []
for (const r of rs) {
  r.findings.forEach((f, i) => {
    const v = r.verdicts.find((x) => x.index === i + 1)
    merged.push({
      dim: r.key, ...f,
      verdict: v ? v.verdict : '未拿到判定',
      verifyReason: v ? v.reason : '验证员没返回这一条',
      correction: v && v.correction,
      severityAdjusted: v && v.severityAdjusted,
    })
  })
}

// 跨维度去重：同文件、行号相差 ≤3 视为同一处。不另起 agent（零成本），只合并展示，
// 保留先出现的那条，把其他维度名连同它们各自的判定记进 alsoFoundBy——
// 两个验证员判定冲突时不替人选，冲突原样摆在 alsoFoundBy 里让人看
const 去重 = []
for (const m of merged) {
  const dup = 去重.find((x) => x.file === m.file && Math.abs((x.line || 0) - (m.line || 0)) <= 3 && x.dim !== m.dim)
  if (dup) {
    ;(dup.alsoFoundBy ||= []).push(`${m.dim}（${m.verdict}）`)
  } else {
    去重.push(m)
  }
}

// 四个桶，不是三个：「读不出结论」是验证员读了但判不了，「未判定」是压根没返回。
// 两者都不等于"没问题"，但卡住的原因不同，处理方式也不同
const 成立   = 去重.filter((m) => m.verdict === '成立')
// 「只提醒、不删」：既有的无关死代码不进本次改动方案，单列「建议清理」由用户决定。
// 整库审查时死代码维度的全部发现都归这里；限定了 diff 时，只有 preexisting=true 的才归这里
// （本次改动自己制造的孤儿属于本次改动，留在主方案里）
const 是清理 = (m) => m.dim === 'dead-code-overdesign' && (!P.diffBase || m.preexisting === true)
const 建议清理 = 成立.filter(是清理)
const 确认   = 成立.filter((m) => !是清理(m))
const 需拍板 = 确认.filter((m) => m.needsDecision)
const 证伪   = 去重.filter((m) => m.verdict === '不成立')
const 存疑   = 去重.filter((m) => m.verdict === '读不出结论')
const 未判定 = 去重.filter((m) => m.verdict === '未拿到判定')
const 被截断 = rs.reduce((n, r) => n + (r.suppressed || 0), 0)

log(`找到 ${merged.length} 条（跨维度去重后 ${去重.length}），确认 ${确认.length}（其中需拍板 ${需拍板.length}），建议清理 ${建议清理.length}，证伪 ${证伪.length}，存疑 ${存疑.length}，未判定 ${未判定.length}`)
if (失败维度.length) log(`❌ 维度 ${失败维度.join(', ')} 的找手没有返回——这些维度**没审**，0 条不代表干净，需要重跑`)
if (存疑.length) log(`⚠️ ${存疑.length} 条「读不出结论」——这是人工复核的第一优先级,不要当成"没问题"`)
if (未判定.length) log(`⚠️ ${未判定.length} 条没拿到判定，去 journal.jsonl 核原始返回值，不要当成"没问题"`)
if (被截断) log(`⚠️ 另有 ${被截断} 条因每维度 8 条上限没报上来。要拿全就按维度拆细再跑一轮`)

// 现成的 markdown 报告：脚本里没有写文件的能力，由调用方（SKILL.md 步骤 3）把它落盘，再据此出修改方案
const 条目 = (m) => `- **[${m.severityAdjusted || m.severity}] ${m.title}** — \`${m.file}:${m.line}\`（${m.dim}${m.alsoFoundBy ? `；另被 ${m.alsoFoundBy.join('、')} 报出` : ''}）
  - 失败场景：${m.failure}
  - 验证：${m.verifyReason}${m.correction ? `\n  - 修正：${m.correction}` : ''}
  - 最简修法：${m.fix}${m.alternatives ? `\n  - 其他改法与取舍：${m.alternatives}` : ''}${m.impact ? `\n  - 影响面：${m.impact}` : ''}${m.needsDecision ? `\n  - ⚠️ 需人拍板：${m.needsDecision}` : ''}`
const 分级 = ['A-阻断', 'B-重要', 'C-建议']
const 报告 = [
  `# 代码审查报告`,
  `维度：${DIMS.map((d) => d.key).join(', ')}${P.diffBase ? `；范围：diff ${P.diffBase}...HEAD` : ''}`,
  失败维度.length ? `\n> ❌ 未审成：${失败维度.join(', ')}（找手无返回，0 条≠干净）` : '',
  被截断 ? `> ⚠️ 被截断 ${被截断} 条，本轮没报全` : '',
  // 需要人拍板的单独拎到最前面，别埋在一大段里被「顺手一起同意」
  需拍板.length ? `\n## ⚠️ 需你拍板（${需拍板.length}）\n${需拍板.map((m) => `- **${m.title}** — \`${m.file}:${m.line}\`：${m.needsDecision}${m.alternatives ? `（可选改法：${m.alternatives}）` : ''}`).join('\n')}` : '',
  `\n## 确认（${确认.length}）`,
  ...分级.map((lv) => {
    const xs = 确认.filter((m) => (m.severityAdjusted || m.severity) === lv)
    return xs.length ? `\n### ${lv}\n${xs.map(条目).join('\n')}` : ''
  }),
  建议清理.length ? `\n## 建议清理·非本次范围，只提醒、不动（${建议清理.length}）\n${建议清理.map((m) => `- ${m.title} — \`${m.file}:${m.line}\`（${m.failure}）`).join('\n')}` : '',
  `\n## 存疑·人工复核第一优先（${存疑.length}）`,
  ...存疑.map((m) => `- ${m.title} — \`${m.file}:${m.line}\`（${m.dim}）卡在：${m.verifyReason}`),
  `\n## 未判定·去 journal.jsonl 核（${未判定.length}）`,
  ...未判定.map((m) => `- ${m.title} — \`${m.file}:${m.line}\`（${m.dim}）`),
  `\n## 证伪·抽查（${证伪.length}）`,
  ...证伪.map((m) => `- ${m.title}（${m.dim}）— ${m.verifyReason}`),
].filter((x) => x !== '').join('\n')

return {
  报告,
  确认,
  需拍板: 需拍板.map((m) => ({ dim: m.dim, title: m.title, file: m.file, line: m.line, 原因: m.needsDecision })),
  建议清理,
  存疑: 存疑.map((r) => ({ dim: r.dim, title: r.title, file: r.file, line: r.line, 卡在哪: r.verifyReason })),
  证伪: 证伪.map((r) => ({ dim: r.dim, title: r.title, 为何否掉: r.verifyReason })),
  未判定,
  被截断,
  失败维度,
}
