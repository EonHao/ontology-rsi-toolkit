# Ontology RSI Toolkit

- 任务：RSI-Q008，[penguin-harness-community#37](https://github.com/Prism-Shadow/penguin-harness-community/issues/37)
- 作者：EonHao
- 状态：已实现，已在 GDPevo-essential 全部六组上评测

[English](DESIGN.md)

## 概述

GDPevo 的训练题和测试题共享的是领域，不是题目。本工具包把这个领域学成一份类型化本体，存在 Target 的 Agent State 里，内容包括实体、关系、生命周期、数据源优先级、动作契约和约束。

难点在于判断哪条规则是对的。现有工具包的做法是带着候选规则重跑 agent，比较总分。这个信号里混着规则本身的作用、每次运行的随机波动，以及上下文里其他所有规则的影响。本工具包改为逐条直接检验：

1. 每条策略规则声明它决定答案里的哪些字段（`decides`）。
2. **实验**：脚本按规则修改已保存答案里的这些字段，请训练 judge 重新打分，并与事先给定的预测比较。这一步不运行模型。被证伪的规则在任何 agent 读到之前就退役。
3. **复现**：全新的 agent 只依靠本体重新做题。它们在规则决定的字段上保持或获得得分，规则才保留；只要有一处丢分，规则就退役。

结构类知识（实体、关系、生命周期）凭环境返回内容的逐字引用发布。

在 GDPevo-essential 上，六组测试均分从 56.32（baseline）提升到 67.78 ± 0.60。

## 动机

### 什么能迁移

`train-00k` 和 `test-00k` 是同一类任务，记录不同。它们共享记录类型、记录之间如何关联和变更状态、哪个数据源优先，以及哪些决定是允许的。具体的实例值不能迁移。

### 为什么总分无法判断单条规则

本工具包的第一版在重做题目分数上升时提升规则。在 Coverage Review 上，训练均分从 89.9 降到 83.0，测试均分 59.33，baseline 是 55.00。

judge 对每份答案只返回一个分数。把保存的答案每次改一个字段再重新打分（113 次 judge 调用，不运行模型），结果是：

- 五道训练题丢分都在同样的四个字段上，即该组所有任务共有的 `basis_audit` 一节。而学习者把预算花在了描述 18 个实体上。
- 两次退步各由一个字段造成，各对应一条错误规则（−16.7 和 −18.2）。

每条规则只需一次 judge 调用，就能在任何 agent 读到之前把这两条证伪。

### 为什么要类型化

类型化的规则有可观测的对象：`decides: [basis_audit.controlling_record_ids]` 把规则绑定到它设定的字段，因此可以单独检验。一段自由文本做不到这一点。类型化也把领域和实例分开：脚本会拒绝点名任务、点名任务输入中的 id，或点名只在一个任务里出现过的记录 id 的内容。

## 设计

### 本体

`ontology.json` 是唯一的数据源；`ONTOLOGY.md` 由它渲染而来供 Target 阅读，只包含 active 元素，上限 6,000 token。

| 类型 | 内容 | 发布条件 |
| --- | --- | --- |
| `entity` | 字段、主键、枚举值、实例存放位置 | 引用 |
| `relation` | 外键、基数 | 引用 |
| `lifecycle` | 合法的状态转换 | 引用 |
| `precedence` | 哪个数据源优先 | 实验，然后复现 |
| `action` | 一个决定需要什么条件、按什么顺序 | 实验，然后复现 |
| `constraint` | 不变量：合计、阈值、日期 | 实验，然后复现 |

策略元素带有 `decides`，即答案路径的列表；`rows.status` 覆盖 `rows` 中每条记录的 `status`。证据分三种：`quote`（指定 Session 中工具输出的原文）、`experiment`（`experiments.jsonl` 中的一条）和 `replication`（`replications.jsonl` 中的一条）。`validate` 会逐条对照记录检查。

### 两道关

| 事件 | 结果 |
| --- | --- |
| `ADD` 一条策略元素 | `candidate`，不渲染 |
| 实验结果符合预测 | `active` |
| 实验结果与预测相反 | `retired`（多条规则一起测时只记录，不退役） |
| 实验分数不变 | 不变 |
| 复现：规则决定的字段在每一次 verify 中都获得得分 | `reproduced` |
| 复现：字段前后都有得分 | 保留 |
| 复现：字段在任何一次中都没有得分 | 退回 `candidate` |
| 复现：字段在任一次 verify 中丢分 | `retired` |
| 复现：从未与 verify 答题配对 | 退回 `candidate` |
| `REFINE` 改变了规则内容 | 退回 `candidate`，之前的证据不再计入 |

实验只能修改被测元素所决定的字段；脚本会比对两份答案，拒绝其他改动。单靠实验这道关是不够的：学习者可以先搜索出得分的值，再写一条规则去贴合它。复现检验的是规则本身能否带来得分，而不是那个值。

### 训练流程

每组一个持续运行的 Ontologist 会话，每次答题都是一个全新的 Actor 会话。

1. **基线**：每题答一次，本体为空。
2. **定位**：`localize` 每次删除一个字段再打分；`gaps` 按多少个任务共有来排序无分字段。
3. **检验**：针对每个缺口，加一条决定该字段的规则，构造一个遵循它的变体答案，运行 `experiment`。
4. **复现**：带着本体每题再答一次，然后运行 `replicate`。
5. **完成**：`finish` 根据记录完成校验、导出和汇总。

| 命令 | 用途 |
| --- | --- |
| `init`、`extract` | 创建学习槽；把 Session 的工具输出提取进证据库 |
| `judge`、`localize`、`gaps` | 给答案打分；逐字段定位得分；跨任务排序缺口 |
| `apply` | `ADD`、`REFINE`、`RETIRE`、`MERGE`，带 schema、引用、原文、实例和预算检查 |
| `experiment`、`replicate` | 两道关 |
| `finish`、`validate`、`export`、`summary` | 交付与检查 |

每条命令都会追加写入 `records.jsonl`，运行报告由它计算得出。

### 由脚本强制

以下情况都在开发版运行中实际发生过。现在由 `onto.mjs` 或 Organizer 拒绝，不再只靠说明文字约束。

| 发生的情况 | 组 | 现在 |
| --- | --- | --- |
| `finish` 之后，Ontologist 往导出目录写了一份 `PLAYBOOK.md`，并修改 `SKILL.md` 去引用它 | Financial Control | `export` 删除不是自己写的文件；Organizer 从校验过的学习槽重新导出后交付 |
| 一次 verify 答题得 61 分（baseline 78），被标成 `rejected`，复现时被跳过 | Court Clerk | `--phase` 只接受 `baseline` 和 `verify`；从未与 verify 配对的规则退回假设 |
| 以超出 judge 预算为由跳过复现 | Court Clerk | 复现只删除规则决定的字段，且不计入预算 |
| 相对路径的 `--work` 把记录分成了两处 | Court Clerk | `--work` 必须等于训练配置里的 `paths.work` |
| 第二次 verify 答题覆盖了第一次 | Court Clerk | 所有 verify 答题都计入；任何一次丢分都算有害 |
| 大部分 judge 调用没有留下记录 | Engineering Portfolio Analytics | 每次 judge 调用都写入记录 |

### 包结构

```text
ontology-rsi-toolkit/
├── src/index.ts                 # card 和 Skill 声明；构建时生成 ifaces.json
├── skills/ontology-rsi-toolkit/
│   ├── SKILL.md                 # Organizer：准备、训练、冻结、测试、报告
│   ├── references/              # benchmark、初始化、训练、Ontologist、评测
│   └── scripts/onto.mjs         # 只用 Node 内置模块
└── test/
```

card 的分类为 `rsi`，工具包因此出现在 Optimize 页面的 **Method** 下拉框中。`references/evaluation.md` 与其他容器训练类工具包逐字节相同。包里不带任何领域内容；`onto.mjs init` 在 Target 的 State 中创建 `skills/domain-ontology/`。

## 评测

### 协议

- `penguin-harness-benchmark` 版本 `010fda6b`；`@prismshadow/penguin-cli` 0.2.18，来自 npm（PR #16 记录中的 0.2.19 没有发布）。
- 所有角色都用 `deepseek-flash`，thinking `max`。API 只返回别名；截至 2026-11-12，它指向 DeepSeek-V4.1-Flash-1017。
- 每组训练一次（6 小时预算）。冻结后的 State 测试三轮，每题都在全新容器中运行。
- 六组都使用 toolkit commit `4697d39`。
- baseline：PR #16 的记录。在 0.2.18 上重跑 Coverage Review 的 baseline，12 格有效结果平均 56.0，公布值为 55.00。

### 结果

测试分：三轮的均值 ± 样本标准差。训练分：全新 Actor 在训练题上的得分，前为不带本体，后为带本体。规则：交付的策略元素按复现结果分类。

| 组 | Baseline | 测试 | 训练 | 规则（复现 / 保留） | judge 调用 | 训练成本 |
| --- | --- | --- | --- | --- | --- | --- |
| Coverage Review | 55.00 | 58.33 ± 2.89 | 84.6 → 93.4 | 3 / 6 | 225 | $0.83 |
| Service Ticket Resolution | 48.90 | 85.10 ± 0.35 | 88.2 → 94.1 | 4 / 5 | 255 | $0.78 |
| Financial Control | 50.96 | 63.42 ± 0.94 | 73.9 → 92.0 | 4 / 2 | 416 | $0.53 |
| Court Clerk Operations | 52.60 | 52.21 ± 3.65 | 86.5 → 87.6 | 1 / 0 | 658 | $0.59 |
| Portfolio Management | 70.16 | 75.07 ± 2.29 | 71.9 → 90.5 | 5 / 9 | 571 | $1.05 |
| Engineering Portfolio Analytics | 60.32 | 72.55 ± 0.00 | 43.9 → 100 | 10 / 4 | 430 | $1.10 |
| **均值** | **56.32** | **67.78 ± 0.60** | | | | **$4.87** |

- 30 道测试题中有 24 道不低于该题的 baseline 均分。
- 交付的规则在复现中没有一条有害。Engineering Portfolio Analytics 有两条规则被实验证伪，没有到达任何 Actor。
- Court Clerk 在训练上提升很小（86.5 → 87.6），只有一条规则通过两道关，测试与 baseline 持平。

每次运行之间的波动很大。此前用开发版 toolkit 完整跑过一次，六组均分 69.11；两次运行在单组上最多相差 21.7 分（Coverage Review：80.00 对 58.33）。按 benchmark 协议每组只训练一次，得到的是一个噪声较大的估计。

## 不变量

- 每个未退役的元素都引用了原文；每条 active 的策略元素都有一条记录在案的确认实验。
- rubric、参考答案和 verifier 输出都不进入循环。唯一的反馈是训练 judge 的分数。
- Actor 在已发布本体上的每次答题都计入，不重新标记、不丢弃、不覆盖。
- 导出的训练答案是 Actor 自己的答案；实验用的变体答案从不提交。
- 包里不含领域内容。

## 局限

- 需要一个能对提交答案打分的 judge。没有它，实验这道关无法使用。
- 每类任务只有一道训练题，规则的提出、检验和复现都在同一道题上完成。两道关都无法区分“关于这类任务的规则”和“关于这一道题的规则”，也没有任何机制阻止只在一道题上确认的规则声明为 `global`。这是训练与测试差距的主要来源。
- 只按整节打分的部分，拿不到逐字段的信号。
- 探索本质上是在 judge 上搜索。复现限制了搜索结果能交付什么；每组的 judge 调用次数都如实报告。
- `ONTOLOGY.md` 每题最多增加约 6k token 的上下文。

## 其他方案

- **重跑分数上升就接受**（SkillOpt、SkillAdam）：要花 agent 运行的成本，归因也差。第一版就是这样做的。
- **只做实验**：能说明值是对的，不能说明规则能产生这个值。
- **只做复现**：不需要 judge，但每条错误规则都会先到达 agent。
- **自由文本笔记**：没有声明的可观测对象，无法做实验。

交付方式：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A（当前） | 独立仓库；GitHub Release 提供压缩包；在 `penguin-harness-plugins` 中加条目 | 符合索引的设计；源码不在 Prism-Shadow 下 |
| B | `penguin-harness/plugins/ontology-rsi-toolkit/` | 和其他工具包放在一起；需要维护者同意 |

包的结构保证改为 B 时只需移动目录。

## 相关工作

| 方法 | 如何保留一次修改 | 区别 |
| --- | --- | --- |
| [ACE](https://arxiv.org/abs/2510.04618) | Reflector 的 helpful/harmful 计数 | 功劳由模型对整次运行的判断决定 |
| [SkillOpt](https://arxiv.org/abs/2605.23904)、SkillAdam | 重跑均分必须上升 | 按整次重跑归因 |
| [TRACE](https://arxiv.org/abs/2608.22793) | 对比成功和失败的轨迹；按训练分选检查点 | 按轨迹组归因 |
| [EvoOntology](https://arxiv.org/abs/2609.15779) | 在验证集上两两比较 | 需要验证集；没有动作契约 |
| [EvoBelief](https://arxiv.org/abs/2610.12789) | 使用前验证；反例使规则退役 | 思路最接近；这里的检验是修改输出 |
| [TTSE](https://arxiv.org/abs/2609.24289) | 批量失败归因；FACT/TIP 两个库 | 把结构和策略分开的最直接先例 |

## 待定问题

1. 交付方式：A 还是 B？
2. 0.2.19 没有发布，用 penguin-cli 0.2.18 跑的结果能否作为排行榜条目？
3. `references/evaluation.md` 列了四个方法名，且必须在各工具包间逐字节相同。是否加入 `ontology`？
4. adapter 在 0.2.18 上有启动竞态（设置轮数上限时返回 503，状态 `config_failed`），这些运行中 231 个 trial 里出现了 4 次。在 `helper.mjs` 里加一次短暂重试即可消除。
5. 插件索引要求导出 `activate`，而自 PRFC-0003 v1.1.0 起，纯内容插件（包括 harness 自带的所有 RSI 工具包）都没有这个导出。索引是否应接受这类插件？
