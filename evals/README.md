# evals：这套审查到底灵不灵

方法的核心主张是「验证员能毙掉假阳性」，所以需要一份**有标准答案的靶子**，改了 prompt/脚本后能回归。

- `sample-app/`：约 100 行的扣费/退款代码。缺陷类：3 个真问题 + 1 个诱饵；整理类：3 处该删/该简化 + 2 个「看着可删其实不能删」的诱饵（一个靠 `getattr` 动态调用，一个是剥 ```json 包裹）。
- `expected.json`：标准答案。

## 怎么跑

**缺陷类**（约 20 万 token，2 个 agent）：

对 Claude Code 说：

> 用 adversarial-code-review 跑 evals/sample-app，只开 backend-bugs，paths 填 evals/sample-app 的绝对路径，project 写「示例扣费系统，charge 是不可逆副作用」。

即 `args: { paths: {app: "<abs>/evals/sample-app"}, project: "...", only: ["backend-bugs"] }`。

**整理类**（约 40 万 token，4 个 agent 起）：同上，把 `only` 换成 `mode: "cleanup"`。

## 怎么判

| 检查 | 通过标准 |
|---|---|
| 召回 | `must_find` 三条都在『确认』桶里 |
| 去假阳性 | `DECOY-1` 不在『确认』桶里 |
| 整理召回 | `CLEAN-1/2/3` 分别出现在『可删』『可简化』里，且每条的 `影响面（验证员实查）` 非空 |
| 整理去假阳性 | `DECOY-2`（动态调用）、`DECOY-3`（剥 json 包裹）不在『可删』『可简化』里；`DECOY-2` 最好落在『存疑』并写明"有动态引用" |
| 失败场景质量 | 每条确认的 `failure` 都写得出「什么输入/时序 → 什么错误结果」 |

任何一条不过，说明你刚改的 prompt/脚本让审查变钝了。**本目录的结果未纳入自动化**（每次要花额度），改动 `workflow.js` 的 prompt 后手动跑一次。

另外 `python3 -m pyflakes evals/sample-app/billing.py` 应当只报 `undefined name 'reciept'`——这是 BUG-3 的静态可验证部分。
`rg -n 'legacy_format' evals/sample-app` 只会命中定义本身；`rg -n 'on_refund' evals/sample-app` 同样只命中定义——**这正是动态引用诱饵的关键**：只搜名字会误判成死代码。
