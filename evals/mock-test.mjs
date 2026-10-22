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

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
