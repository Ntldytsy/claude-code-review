# evals：这套审查到底灵不灵

方法的核心主张是「验证员能毙掉假阳性、并且独立查清影响面」，所以需要一份**有标准答案的靶子**，改了 prompt/脚本后能回归。

- `sample-app/`：约 70 行的扣费/退款代码，**代码里没有任何答案标注**。
  - 缺陷类：3 个真问题（重试重复扣费、退款失败被吞、未定义名）+ 1 个诱饵（`admin_total` 无鉴权但入口已校验）。
  - 整理类：1 处真死代码（`legacy_format`）、2 处有人用但过度复杂（`AmountFormatter`、`total_cents`）、
    2 个「看着可删其实不能删」的诱饵（`on_refund` 靠 `getattr` 动态调用、`parse_model_reply` 剥 ```json 包裹）。
- `expected.json`：标准答案。

## ⚠️ 必须在临时副本上跑

答案在 `expected.json`/本 README 里。验证员会做全仓 `rg`，如果审查目录能扫到本目录，就会读到答案——
第一次评测就因此作废。**把 `sample-app/` 拷到仓库之外再审**：

```bash
cp -R evals/sample-app /tmp/eval-sample-app      # 或你的 scratchpad 目录
```

## 怎么跑

**缺陷类**（约 20 万 token，2 个 agent）：`only: ["backend-bugs"]`

**整理类**（约 20–40 万 token，4 个 agent 起）：`mode: "cleanup"`

对 Claude Code 说「用 adversarial-code-review 跑 /tmp/eval-sample-app，mode 用 cleanup，project 写『示例扣费系统，charge 是不可逆副作用』」，
即 `args: { paths: {app: "/tmp/eval-sample-app"}, project: "...", mode: "cleanup" }`。

**验证员专测**（约 5 万 token，1 个 agent）：找手可能根本不报诱饵，那验证员就没被考到。
用 `args.inject` 把「保守找手会写出的错误结论」直接喂给验证员，跳过找手：

```
args: { paths: {app: "/tmp/eval-sample-app"}, project: "...", only: ["dead-code"],
        inject: { "dead-code": [ {kind:"精简", cleanupType:"删除", title:"on_refund 无调用方，死代码",
                                  file:"billing.py", line:80, evidence:"<逐字摘自文件>", failure:"...",
                                  fix:"...", severity:"C-建议", impact:"rg 'on_refund' → 仅定义"}, ... ] } }
```

`evidence` 必须逐字存在于文件里（验证员会核对）；行号以实际文件为准。期望见 `expected.json` 的 `verifier_only_test`。

## 怎么判

| 检查 | 通过标准 |
|---|---|
| 缺陷召回 | `BUG-1/2/3` 都在『缺陷·确认』里 |
| 缺陷去假阳性 | `DECOY-1` 不在『缺陷·确认』里 |
| 整理召回 | `CLEAN-1` 在『可删』；`CLEAN-2/3` 在『可删』或『可简化』里且**不是整段误判成死代码**；每条 `影响面（验证员实查）` 非空 |
| 整理去假阳性 | `DECOY-2/3` 不在『可删』『可简化』里 |
| **验证员是否真被考到** | `DECOY-2/3` 最好**被找手报出**，再看验证员怎么判（`DECOY-2` 理想是不成立或存疑并写明"有动态引用"）。找手没报只说明找手保守，不算验证员通过 |
| 失败场景/影响面质量 | 缺陷的 `failure` 写得出输入/时序→错误结果；精简的 `impactChecked` 有命令、有命中、有动态引用结论 |

任何一条不过，说明你刚改的 prompt/脚本让审查变钝了。

### 已有的实测记录（0.4.1）
- 整理类完整跑（`mode: cleanup`，4 个 agent，约 20 万 token）：CLEAN-1/2/3 实质都命中，每条影响面非空；`on_refund`、`parse_model_reply` 找手没报（保守）。
- 验证员专测（`inject`，1 个 agent，约 5 万 token）：`legacy_format` 成立；`on_refund`（动态调用）、`parse_model_reply`（剥 json）都被正确否掉，理由是验证员自己顺着 `admin_cli → dispatch → getattr` 查出来的。
- 已知边界（0.4.1）：`total_cents` 的简化，验证员在两次实测里给过两种判法（一次成立并提醒行为差异，一次不成立），对「行为是否等价」偏严。
- 0.5.0 调整判据后复测（`inject`，1 个 agent，约 5 万 token）：`total_cents` 判**成立**，correction 给出行为等价的保守写法 `sum(o.get('cents', 0) for o in orders)`；`on_refund` 仍判不成立（顺着 `admin_cli → dispatch → getattr` 查出活引用）；`legacy_format` 仍成立。
  **n=1，只能说明方向对，不能说明稳定**：这类边界例要多跑几次再下结论。**本目录结果未纳入自动化**（每次要花额度），改动 `workflow.js` 的 prompt 后手动跑一次。

另外 `python3 -m pyflakes evals/sample-app/` 应当只报 `undefined name 'reciept'`（BUG-3 的静态可验证部分）。
