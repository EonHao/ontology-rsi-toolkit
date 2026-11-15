# Ontology RSI Toolkit

- Quest: RSI-Q008, [penguin-harness-community#37](https://github.com/Prism-Shadow/penguin-harness-community/issues/37)
- Author: EonHao
- Status: implemented; evaluated on all six GDPevo-essential groups

[中文版](DESIGN.zh.md)

## Summary

Training and test tasks in GDPevo share a domain, not a task. This toolkit learns that domain as a typed ontology kept in the Target's Agent State: entities, relations, lifecycles, source precedence, action contracts and constraints.

The hard part is deciding which rules are right. Existing toolkits rerun the agent with a candidate and compare total scores. That signal mixes the rule's effect with run-to-run variance and with every other rule in context. This toolkit tests each rule directly instead:

1. A policy rule names the answer fields it `decides`.
2. **Experiment.** The script edits those fields in a saved answer, asks the training judge, and compares scores against a prediction fixed in advance. No model runs. A refuted rule is retired before any agent reads it.
3. **Replication.** Fresh agents solve the tasks with only the ontology. A rule stays only if they keep or gain credit on its fields; it is retired if they lose any.

Structure (entities, relations, lifecycles) is published on a verbatim quote of what the environment returned.

On GDPevo-essential the six-group test mean goes from 56.32 (baseline) to 67.78 ± 0.78.

## Motivation

### What transfers

`train-00k` and `test-00k` are the same kind of task with different records. They share record types, how records link and change state, which source wins, and which decisions are allowed. Instance values do not carry over.

### Why a total score cannot credit a rule

The first version of this toolkit promoted a rule when a retry scored higher. On Coverage Review the training mean fell from 89.9 to 83.0, and the test mean was 59.33 against a baseline of 55.00.

The judge returns one number per answer. Replaying the saved answers with one field changed at a time (113 judge calls, no model) showed:

- All five training answers lost credit in the same four fields, the `basis_audit` section every task in the group shares. The learner had spent its budget describing 18 entities.
- Each of the two regressions came from one field set by one wrong rule (−16.7 and −18.2).

One judge call per rule would have refuted both before any agent saw them.

### Why types

A typed rule has an observable: `decides: [basis_audit.controlling_record_ids]` ties it to the field it sets, so it can be tested in isolation. A paragraph of free text cannot. Types also separate the domain from instances: the script rejects content that names a task, an id from a task's input, or a record id seen in only one task.

## Design

### Ontology

`ontology.json` is the source of truth; `ONTOLOGY.md` is rendered from it for the Target and shows active elements only, within 6,000 tokens.

| Kind | Holds | Published on |
| --- | --- | --- |
| `entity` | Fields, key, enums, where instances live | A quote |
| `relation` | Foreign keys, cardinality | A quote |
| `lifecycle` | Legal state transitions | A quote |
| `precedence` | Which source wins | Experiment, then replication |
| `action` | What a decision requires, in which order | Experiment, then replication |
| `constraint` | Invariants: totals, thresholds, dates | Experiment, then replication |

Policy elements carry `decides`, a list of answer paths; `rows.status` covers the `status` of every record in `rows`. Evidence is one of `quote` (verbatim tool output from a named Session), `experiment` (an entry in `experiments.jsonl`) or `replication` (an entry in `replications.jsonl`). `validate` checks every one against the records.

### The gates

| Event | Effect |
| --- | --- |
| `ADD` a policy element | `candidate`; not rendered |
| Experiment moves as predicted | `active` |
| Experiment moves the other way | `retired` (a bundle is only recorded) |
| Experiment does not move | unchanged |
| Replication: a decided field gains credit in every verify attempt | `reproduced` |
| Replication: fields had credit before and after | stays |
| Replication: fields had credit in no attempt | back to `candidate` |
| Replication: a field loses credit in any verify attempt | `retired` |
| Replication: never paired with a verify attempt | back to `candidate` |
| `REFINE` that changes the rule | back to `candidate`; earlier evidence no longer counts |

An experiment may change only fields the tested elements decide; the script diffs the two answers and refuses anything else. The experiment gate alone is weak: a learner can find a value by search and then write a rule to fit it. Replication checks that the rule, not the value, carries the credit.

### Training loop

One continuing Ontologist session per group; each attempt is a fresh Actor session.

1. **Baseline.** One attempt per task, empty ontology.
2. **Map.** `localize` removes one field at a time and re-judges; `gaps` ranks fields without credit by how many tasks share them.
3. **Test.** For each gap: add a rule that decides the field, build a variant that follows it, run `experiment`.
4. **Replicate.** One attempt per task with the ontology, then `replicate`.
5. **Finish.** `finish` validates, exports and summarizes from the records.

| Command | Purpose |
| --- | --- |
| `init`, `extract` | Create the slot; pull a Session's tool outputs into the corpus |
| `judge`, `localize`, `gaps` | Score an answer; map credit per field; rank gaps across tasks |
| `apply` | `ADD`, `REFINE`, `RETIRE`, `MERGE`, with schema, reference, quote, instance and budget checks |
| `experiment`, `replicate` | The two gates |
| `finish`, `validate`, `export`, `summary` | Deliver and check |

Every command appends to `records.jsonl`; the run report is computed from it.

### Enforced by the script

Each of these happened in the development run and is now refused by `onto.mjs` or the Organizer rather than left to the instructions.

| Observed | Group | Now |
| --- | --- | --- |
| After `finish`, the Ontologist wrote a `PLAYBOOK.md` into the export folder and edited `SKILL.md` to cite it | Financial Control | `export` deletes files it did not write; the Organizer deploys a fresh export of the validated slot |
| A verify attempt that scored 61 against a baseline of 78 was labelled `rejected` and skipped by replication | Court Clerk | `--phase` accepts `baseline` and `verify` only; a rule never paired with a verify attempt is demoted |
| Replication was skipped because it would exceed the judge budget | Court Clerk | Replication knocks out decided fields only and is not budgeted |
| A relative `--work` split the records in two | Court Clerk | `--work` must equal the request's `paths.work` |
| A second verify attempt replaced the first | Court Clerk | All verify attempts count; a loss in any is a harm |
| Most judge calls left no record | Engineering Portfolio Analytics | Every judge call is recorded |

### Package

```text
ontology-rsi-toolkit/
├── src/index.ts                 # card and Skill contributions; build emits ifaces.json
├── skills/ontology-rsi-toolkit/
│   ├── SKILL.md                 # Organizer: prepare, train, freeze, test, report
│   ├── references/              # benchmark, initialization, training, ontologist, evaluation
│   └── scripts/onto.mjs         # Node built-ins only
└── test/
```

The card has category `rsi`, so the toolkit appears under **Method** in the Optimize tab. `references/evaluation.md` is byte-identical to the other container-training toolkits. The package ships no domain content; `onto.mjs init` creates `skills/domain-ontology/` in the Target's State.

## Evaluation

### Protocol

- `penguin-harness-benchmark` at `010fda6b`; `@prismshadow/penguin-cli` 0.2.18 from npm (0.2.19, named in the PR #16 records, is not published).
- `deepseek-flash` at thinking `max` for every role. The API reports only the alias; as of 2026-11-12 it serves DeepSeek-V4.1-Flash-1017.
- One training run per group (6 h budget). Three test repetitions of the frozen State, each case in a fresh container.
- Toolkit commit `4697d39` for all six groups.
- Baseline: the PR #16 records. A rerun of the Coverage Review baseline on 0.2.18 averaged 56.0 over 12 completed cells against 55.00 published.

### Results

Test score: mean ± sample std over three repetitions; attempt j of a case is its j-th trial by start time. Train: fresh Actors on the training tasks, before → after the ontology. Rules: deployed policy elements by replication outcome.

| Group | Baseline | Test | Train | Rules (reproduced / held) | Judge calls | Training cost |
| --- | --- | --- | --- | --- | --- | --- |
| Coverage Review | 55.00 | 58.33 ± 2.89 | 84.6 → 93.4 | 3 / 6 | 225 | $0.83 |
| Service Ticket Resolution | 48.90 | 85.10 ± 0.83 | 88.2 → 94.1 | 4 / 5 | 255 | $0.78 |
| Financial Control | 50.96 | 63.42 ± 0.94 | 73.9 → 92.0 | 4 / 2 | 416 | $0.53 |
| Court Clerk Operations | 52.60 | 52.21 ± 0.50 | 86.5 → 87.6 | 1 / 0 | 658 | $0.59 |
| Portfolio Management | 70.16 | 75.07 ± 2.29 | 71.9 → 90.5 | 5 / 9 | 571 | $1.05 |
| Engineering Portfolio Analytics | 60.32 | 72.55 ± 0.00 | 43.9 → 100 | 10 / 4 | 430 | $1.10 |
| **Mean** | **56.32** | **67.78 ± 0.78** | | | | **$4.87** |

- 24 of 30 test cases are at or above their baseline mean.
- No deployed rule was harmful in replication. Two rules in Engineering Portfolio Analytics were refuted by experiment and never reached an Actor.
- Court Clerk improved little on training (86.5 → 87.6), and only one rule passed both gates; test stayed at baseline.

Run-to-run variance is large. An earlier full run, with a development version of the toolkit, averaged 69.11; per group the two runs differed by up to 21.7 points (Coverage Review: 80.00 vs 58.33). One training run per group, as the benchmark protocol prescribes, is a noisy estimate.

## Invariants

- Every non-retired element cites a verbatim quote; every active policy element cites a confirming experiment on record.
- Nothing from a rubric, reference answer or verifier output enters the loop. The only feedback is the training judge's score.
- Every Actor attempt on the published ontology counts. None is relabelled, dropped or overwritten.
- Exported training answers are the Actors' own; experiment variants are never submitted.
- The package contains no domain content.

## Limitations

- Requires a judge that scores a submitted answer on request. Without one the experiment gate does not apply.
- Each task type has one training task, so a rule is derived, tested and replicated on the same task. Neither gate can tell a rule about the type from a rule about that task, and nothing stops a rule confirmed in one task from being scoped `global`. This is the main source of the train − test gap.
- A section scored only as a whole gives no per-field signal.
- Exploration is a search over the judge. Replication limits what it can deploy; the judge calls are reported per group.
- `ONTOLOGY.md` adds up to about 6k tokens per task.

## Alternatives

- **Accept on a higher rerun score** (SkillOpt, SkillAdam): costs agent runs and attributes poorly. The first version did this.
- **Experiment only:** shows the value is right, not that the rule produces it.
- **Replication only:** works without a judge, but every wrong rule reaches an agent first.
- **Free-text notes:** no declared observable, so no experiment.

Delivery:

| Option | How | Trade-off |
| --- | --- | --- |
| A (current) | Own repository; GitHub Release tarball; entry in `penguin-harness-plugins` | Matches the index; source lives outside Prism-Shadow |
| B | `penguin-harness/plugins/ontology-rsi-toolkit/` | Next to the other toolkits; needs maintainer agreement |

The package is laid out so that B is a directory move.

## Prior art

| Method | How an edit is kept | Difference |
| --- | --- | --- |
| [ACE](https://arxiv.org/abs/2510.04618) | Reflector's helpful/harmful counters | Credit is a model's opinion of a run |
| [SkillOpt](https://arxiv.org/abs/2605.23904), SkillAdam | Rerun mean must rise | Credit by whole reruns |
| [TRACE](https://arxiv.org/abs/2608.22793) | Contrasting trajectories; checkpoint by training score | Credit by trajectory groups |
| [EvoOntology](https://arxiv.org/abs/2609.15779) | Pairwise comparison on a validation split | Needs a validation split; no action contracts |
| [EvoBelief](https://arxiv.org/abs/2610.12789) | Validation before use; counterexamples retire rules | Closest in spirit; here the test is an edit to the output |
| [TTSE](https://arxiv.org/abs/2609.24289) | Batch failure attribution; FACT/TIP banks | Closest precedent for separating structure from policy |

## Open questions

1. Delivery: A or B?
2. Is penguin-cli 0.2.18 acceptable for a leaderboard entry, given 0.2.19 is not published?
3. `references/evaluation.md` lists four method names and must stay byte-identical across toolkits. Should it gain `ontology`?
4. The adapter's startup race on 0.2.18 (a 503 when setting the turn cap; status `config_failed`) hit 4 of 231 trials in these runs. A short retry in `helper.mjs` would remove it.
5. The plugin index requires an `activate` export, which content-only plugins (all built-in RSI toolkits included) do not have since PRFC-0003 v1.1.0. Should the index accept them?
