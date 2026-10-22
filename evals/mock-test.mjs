// 零 token 的脚本回归：用假的 agent()/pipeline() 驱动 workflow.js，检查「发现不会无声消失」等不变量。
// 用法：node evals/mock-test.mjs        改了 workflow.js 之后先跑这个，再花额度跑真评测。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
// WORKFLOW=<路径> 可指定别的版本（比如拿修复前的版本验证这个测试真的能抓到 bug）
const SRC = fs.readFileSync(process.env.WORKFLOW || path.join(here, '../skills/code-review/workflow.js'), 'utf8').replace(/^export const meta/m, 'const meta')

async function run(args, agentImpl) {
  const logs = [], labels = []
  const fn = new Function('args', 'phase', 'log', 'agent', 'pipeline', `return (async()=>{${SRC}})()`)
  const agent = async (prompt, o) => { labels.push(o.label); return agentImpl(prompt, o) }
  const pipeline = (items, f1, f2) => Promise.all(items.map(async (d) => f2(await f1(d), d)))
  const r = await fn(args, () => {}, (m) => logs.push(m), agent, pipeline)
  return { r, logs, labels }
}
const base = { paths: { a: '/a', b: '/b' }, project: 'p' }
const bug = (extra) => ({ kind: '缺陷', title: '起点大于终点', file: 'a.py', line: 3, evidence: 'e', failure: 'f', fix: 'x', severity: 'B-重要', ...extra })
const clean = (extra) => ({ kind: '精简', cleanupType: '删除', title: '死函数', file: 'b.py', line: 1, evidence: 'e', failure: 'f', fix: 'x', severity: 'C-建议', linesSaved: 3, ...extra })
const verdictN = (prompt, f) => ({ verdicts: Array.from({ length: (prompt.match(/【\d+】/g) || []).length }, (_, i) => ({ index: i + 1, verdict: '成立', reason: 'ok', impactChecked: 'rg → x', ...f })) })
const section = (md, from, to) => md.split(from)[1]?.split(to)[0] ?? ''

let failed = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) failed++ }

// 1. 验证员把严重度写成任何写法，缺陷都必须出现在「缺陷」章节（0.5.1 修的 bug）
for (const v of ['C-建议', 'C', 'C级（降级）', '低', '降为C', '随便写点什么']) {
  const { r } = await run({ ...base, only: ['backend-bugs'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [bug()] } : verdictN(p, { severityAdjusted: v }))
  const body = section(r.报告, '## 缺陷', '## 整理清单')
  check(`严重度写成「${v}」仍在缺陷章节`, body.includes('起点大于终点'), body.slice(0, 80))
}
// 2. 找手没返回 ≠ 该维度干净
{
  const { r } = await run({ ...base, only: ['backend-bugs'] }, (p, o) => o.label.startsWith('find:') ? null : verdictN(p, {}))
  check('找手无返回 → 记入失败维度', r.失败维度.length === 1, JSON.stringify(r.失败维度))
}
// 3. 精简类「成立」但验证员没写 impactChecked → 降级，不进「可删」
{
  const { r } = await run({ ...base, only: ['dead-code'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [clean()] } : verdictN(p, { impactChecked: '' }))
  check('缺 impactChecked 的精简类不进可删', r.可删.length === 0 && r.存疑.length === 1, `可删=${r.可删.length} 存疑=${r.存疑.length}`)
}
// 4. 精简类按 cleanupType 分桶
{
  const { r } = await run({ ...base, only: ['dead-code'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [clean({ cleanupType: '简化' })] } : verdictN(p, {}))
  check('cleanupType=简化 进「可简化」', r.可简化.length === 1 && r.可删.length === 0)
}
// 5. 验证员给的 correctedLine 被采用
{
  const { r } = await run({ ...base, only: ['backend-bugs'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [bug()] } : verdictN(p, { correctedLine: 42 }))
  check('correctedLine 覆盖行号', r.确认[0].line === 42, String(r.确认[0].line))
}
// 6. inject 跳过找手
{
  const { labels } = await run({ ...base, only: ['dead-code'], inject: { 'dead-code': [clean()] } }, (p, o) => verdictN(p, {}))
  check('inject 不起找手', !labels.some((l) => l.startsWith('find:')), labels.join(','))
}
// 7. shard 按分区展开
{
  const { labels } = await run({ ...base, only: ['backend-bugs'], shard: true }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [] } : verdictN(p, {}))
  check('shard 2 分区 → 2 个找手', labels.filter((l) => l.startsWith('find:')).length === 2, labels.join(','))
}
// 8. 20 条精简发现分 3 批验证，且下标不错位
{
  const many = Array.from({ length: 15 }, (_, i) => clean({ title: `d${i}`, file: `f${i}.py` }))
  const { r, labels } = await run({ ...base, only: ['dead-code'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: many } : verdictN(p, {}))
  check('15 条分 2 批验证、全部回填', labels.filter((l) => l.startsWith('verify:')).length === 2 && r.可删.length === 15, `${labels} 可删=${r.可删.length}`)
}
// 9. 非法参数直接报错
for (const [name, a] of [['only 拼错', { only: ['nope'] }], ['mode 非法', { mode: 'x' }], ['inject 非数组', { inject: { 'dead-code': 'x' } }]]) {
  let threw = false
  try { await run({ ...base, ...a }, () => null) } catch { threw = true }
  check(`${name} → 报错`, threw)
}

// ── 0.5.2：全量排查补的回归 ─────────────────────────────────────────────
// 10. 去重不能让「不成立」吞掉同一处的「成立」（无论谁先出现）
for (const order of [['backend-bugs', 'security'], ['security', 'backend-bugs']]) {
  const { r } = await run({ ...base, dims: undefined, only: ['backend-bugs'], extraDims: ['security'] }, (p, o) => {
    if (o.label.startsWith('find:')) return { suppressed: 0, findings: [bug({ title: `T-${o.label}` })] }
    const want = o.label === `verify:${order[0]}` ? '不成立' : '成立'
    return { verdicts: [{ index: 1, verdict: want, reason: 'x' }] }
  })
  check(`去重：${order[0]} 先判不成立、${order[1]} 判成立 → 成立的留在缺陷里`, r.确认.length === 1 && r.证伪.length === 0, `确认=${r.确认.length} 证伪=${r.证伪.length}`)
}
// 11. 绝对路径与相对路径指向同一文件 → 要能合并；报告里不出现临时副本的绝对路径
{
  const { r } = await run({ paths: { 后端: '/tmp/x/be' }, project: 'p', only: ['backend-bugs'], extraDims: ['security'] }, (p, o) => {
    if (o.label.startsWith('find:')) return { suppressed: 0, findings: [bug({ file: o.label === 'find:security' ? 'services/a.py' : '/tmp/x/be/services/a.py' })] }
    return verdictN(p, {})
  })
  check('绝对/相对路径合并成一条', r.确认.length === 1, `确认=${r.确认.length}`)
  check('报告里是「分区/相对路径」，不带绝对路径', r.报告.includes('后端/services/a.py') && !r.报告.includes('/tmp/x/be'), r.报告.slice(0, 120))
}
// 12. 项目描述/已知问题里的全角【】不能被当成占位符
{
  let threw = false, prompt = ''
  try { await run({ ...base, only: ['backend-bugs'], project: '【内部工具】做视频', known: ['【重要】已知问题A'] }, (p, o) => { if (o.label.startsWith('find:')) { prompt = p; return { suppressed: 0, findings: [] } } return null }) } catch { threw = true }
  check('project 含「【内部工具】」不误报占位符', !threw)
  check('known 含「【重要】」没被丢掉', prompt.includes('【重要】已知问题A'))
}
// 13. inject / dims / diffBase 校验
for (const [name, a] of [
  ['inject 的 key 不在本轮维度', { only: ['backend-bugs'], inject: { simplify: [clean()] } }],
  ['inject 与 shard 同用', { only: ['dead-code'], shard: true, inject: { 'dead-code': [clean()] } }],
  ['自定义 dims 缺 focus', { dims: [{ key: 'x', role: 'r' }] }],
  ['自定义 dims key 重复', { dims: [{ key: 'x', role: 'r', focus: 'f' }, { key: 'x', role: 'r', focus: 'f' }] }],
  ['diffBase 含 shell 字符', { diffBase: 'main; rm -rf /' }],
]) {
  let threw = false
  try { await run({ ...base, ...a }, () => null) } catch { threw = true }
  check(`${name} → 报错`, threw)
}
// 14. 候选 known 含已证伪的；全员只读规则在 prompt 里
{
  let sawReadonly = true
  const { r } = await run({ ...base, only: ['backend-bugs'] }, (p, o) => {
    if (!p.includes('不得修改、删除、移动、新建被审路径下的任何文件')) sawReadonly = false
    return o.label.startsWith('find:') ? { suppressed: 0, findings: [bug()] } : { verdicts: [{ index: 1, verdict: '不成立', reason: 'x' }] }
  })
  check('候选 known 含已核实不成立的', r.候选known.some((k) => k.includes('已核实不成立')), JSON.stringify(r.候选known))
  check('找手/验证员 prompt 都带「只读」硬规矩', sawReadonly)
}

// ── 0.5.2：独立审查员报告里能复现的问题 ───────────────────────────────────
// 15. 验证员给了无法识别的判定 → 不能掉出所有桶
{
  const { r } = await run({ ...base, only: ['backend-bugs'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [bug()] } : verdictN(p, { verdict: '成立（部分）' }))
  check('无法识别的 verdict 进「存疑」，不消失', r.存疑.length === 1 && r.确认.length + r.证伪.length + r.未判定.length === 0, `存疑=${r.存疑.length}`)
}
// 16. 相邻行的两个不同问题不能被合并掉（一个 A 级 SQL 注入紧挨一个 C 级竞态）
{
  const { r } = await run({ ...base, only: ['backend-bugs'], extraDims: ['security'] }, (p, o) => o.label.startsWith('find:')
    ? { suppressed: 0, findings: [o.label === 'find:security' ? bug({ title: 'SQL注入', line: 5, severity: 'A-阻断' }) : bug({ title: '竞态', line: 3, severity: 'C-建议' })] }
    : verdictN(p, {}))
  check('相邻行的两个问题都保留', r.确认.length === 2 && r.报告.includes('SQL注入') && r.报告.includes('竞态'), r.确认.map((m) => m.title).join(','))
}
// 17. 同一行被两个维度报 → 合并，且败者的标题/更严的严重度/needsDecision 不丢
{
  const { r } = await run({ ...base, only: ['backend-bugs'], extraDims: ['security'] }, (p, o) => o.label.startsWith('find:')
    ? { suppressed: 0, findings: [o.label === 'find:security' ? bug({ title: '越权', severity: 'A-阻断', needsDecision: '改鉴权' }) : bug({ title: '缺校验', severity: 'C-建议' })] }
    : verdictN(p, {}))
  const m = r.确认[0]
  check('同一行合并成一条', r.确认.length === 1)
  const 别名 = (m.alsoFoundBy || []).join()
  check('合并后取更严的严重度 A', r.报告.includes('[A-阻断'), r.报告.split('\n').filter((l) => l.startsWith('- **[')).join('|'))
  check('合并后 needsDecision 保留', m.needsDecision === '改鉴权', String(m.needsDecision))
  check('败者的标题记进别名', 别名.includes('越权') || 别名.includes('缺校验'), 别名)
}
// 18. 验证员越界/重复 index 不能盖掉别的批次的真判定
{
  const many = Array.from({ length: 10 }, (_, i) => clean({ title: `d${i}`, file: `f${i}.py`, line: 1 }))
  const { r } = await run({ ...base, only: ['dead-code'] }, (p, o) => {
    if (o.label.startsWith('find:')) return { suppressed: 0, findings: many }
    const v = verdictN(p, {})
    if (o.label === 'verify:dead-code') v.verdicts.push({ index: 9, verdict: '不成立', reason: '越界' })
    return v
  })
  check('越界 index 被丢弃，10 条都成立', r.可删.length === 10 && r.证伪.length === 0, `可删=${r.可删.length} 证伪=${r.证伪.length}`)
  const { r: r2 } = await run({ ...base, only: ['backend-bugs'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [bug()] }
    : { verdicts: [{ index: 1, verdict: '成立', reason: 'a' }, { index: 1, verdict: '不成立', reason: 'b' }] })
  check('同一 index 矛盾判定 → 读不出结论，不静默取第一个', r2.存疑.length === 1 && r2.确认.length === 0, `存疑=${r2.存疑.length}`)
}
// 19. extraDims 重复不会跑两遍
{
  const { r, labels } = await run({ ...base, extraDims: ['security', 'security'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [bug({ title: o.label })] } : verdictN(p, {}))
  check('extraDims 重复只跑一次', labels.filter((l) => l === 'find:security').length === 1)
}
// 20. 严重度归一：开头字母优先，不被「严重/重要」字样带偏
for (const [v, want] of [['C-建议（不严重）', '### C-建议'], ['C，不重要', '### C-建议'], ['B', '### B-重要'], ['严重', '### A-阻断'], ['高', '### 未分级']]) {
  const { r } = await run({ ...base, only: ['backend-bugs'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [bug({ severity: v })] } : verdictN(p, {}))
  check(`严重度「${v}」归到 ${want}`, r.报告.includes(want), r.报告.split('\n').filter((l) => l.startsWith('### ')).join('|'))
}
// 21. 参数形状校验
for (const [name, a] of [['known 传字符串', { known: '已知A' }], ['paths 为空', { paths: {} }], ['extraDims 传字符串', { extraDims: 'security' }],
  ['dims 未知 kind', { dims: [{ key: 'x', role: 'r', focus: 'f', kind: '乱写' }] }], ['inject 缺 line', { only: ['dead-code'], inject: { 'dead-code': [{ title: 't', file: 'a', evidence: 'e' }] } }],
  ['diffBase 以 - 开头', { diffBase: '-x' }]]) {
  let threw = false
  try { await run({ ...base, ...a }, () => null) } catch { threw = true }
  check(`${name} → 报错`, threw)
}
// 22. cleanupType 带说明文字也归「可删」
{
  const { r } = await run({ ...base, only: ['dead-code'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [clean({ cleanupType: '删除（整个函数）' })] } : verdictN(p, {}))
  check('cleanupType「删除（整个函数）」进可删', r.可删.length === 1 && r.可简化.length === 0)
}
// 23. 多分区下，绝对路径与「去掉分区前缀的相对路径」仍能合并
{
  const { r } = await run({ paths: { 后端: '/tmp/x/be', 前端: '/tmp/x/fe' }, project: 'p', only: ['backend-bugs'], extraDims: ['security'] }, (p, o) => o.label.startsWith('find:')
    ? { suppressed: 0, findings: [bug({ file: o.label === 'find:security' ? 'services/a.py' : '/tmp/x/be/services/a.py' })] } : verdictN(p, {}))
  check('多分区：绝对/相对路径合并', r.确认.length === 1, `确认=${r.确认.length}`)
}
// 24. 存疑/证伪/未判定 的条目带够信息（不用回 journal 翻）
{
  const { r } = await run({ ...base, only: ['backend-bugs'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [bug({ failure: '特征描述XYZ', fix: '修法ABC' })] } : verdictN(p, { verdict: '读不出结论' }))
  check('存疑条目含声称的问题与建议做法', r.报告.includes('特征描述XYZ') && r.报告.includes('修法ABC'))
  const { r: r2 } = await run({ ...base, only: ['backend-bugs'] }, (p, o) => o.label.startsWith('find:') ? { suppressed: 0, findings: [bug()] } : verdictN(p, { verdict: '不成立' }))
  check('证伪条目含 文件:行号', r2.证伪[0].file && r2.证伪[0].line && r2.报告.split('## 证伪')[1].includes('a.py:3'))
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
