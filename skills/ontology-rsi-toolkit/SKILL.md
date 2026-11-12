---
name: ontology-rsi-toolkit
description: Organize Ontology RSI experiments on published Benchmarks - learn a typed domain model (entities, relations, lifecycles, source precedence, action contracts, constraints) whose rules are each confirmed by a controlled experiment on the training judge, freeze it, and compare it with the baseline on independent tests.
version: 2026.11.12.3
---

# Ontology RSI

Design: [DESIGN.md](https://github.com/EonHao/ontology-rsi-toolkit/blob/main/DESIGN.md). Training tasks and test tasks of a Benchmark share a domain, not a task. This toolkit learns that domain as a typed model kept in the Target's own State, `skills/domain-ontology/`, and it settles whether a rule is right without rerunning the agent: every policy element names the answer fields it decides, and a deterministic script ([onto.mjs](scripts/onto.mjs)) changes those fields in a saved answer, asks the training judge, and compares the two scores. The prediction is fixed before the judge is asked, and a refuted rule is retired before any Target reads it. A rule that passes is then given to a fresh Actor with nothing else: it counts as reproduced only where that Actor gains credit on the fields the rule decides, and it is retired where the Actor loses credit. Structure is published on a verbatim quote of the environment's records. Model weights, tools and the harness stay fixed.

This is the outside experiment Organizer's entry point. The Organizer prepares and launches runs, collects artifacts and reports results. Inside each training environment, a continuing main Agent is the Ontologist: it sends each task to a fresh Actor session, maps where credit is lost, states hypotheses and tests them. Install [training.md](references/training.md) there as `ontology-training`. Actors and test solvers receive only the solving instruction and their frozen slot.

## Before you start

Read [benchmark.md](references/benchmark.md) to discover the selected Project's published Train/Test packages and their run contracts. Use the user's benchmark, source version, runtime, output location and budgets when supplied; otherwise resolve them from the current Environment and package instructions. Ask only for essentials that cannot be resolved.

| Setting | Default |
| --- | --- |
| Independent training runs per benchmark/training unit | 1 |
| Actor attempts per task | 2: one `baseline` on the empty slot, one `verify` on the learned one |
| Judge calls per task (distinct answers) | 300 |
| Ontology token budget (rendered view) | 6000 |
| Checkpoint selection | `final`: the last published ontology |
| Test conditions | Baseline and the final ontology |
| Complete test repetitions per condition | 3 |
| Harbor trial concurrency | 4, shared across owned training and testing jobs |

These are toolkit choices, not constants of a paper. Fix the configuration before learning. Use sorted public task ids unless another order is supplied. Five tasks mean 10 fresh Actor sessions in one training run, and at most 1,500 judge calls, none of which runs a model. Five held-out tasks and three repetitions mean 15 test trials per condition, 30 with the baseline. When the experiment reuses a published baseline, record its source, State digest and versions and confirm they match this experiment's runtime and task commit; otherwise measure it.

The method needs a training judge that scores a submitted answer on request. Where the benchmark offers none, say so and stop; do not substitute whole reruns for experiments.

Resolve provider, model and thinking level for Organizer, Ontologist, Actor and test solver. Actor and test solver settings must match. Honor requests for the same model in all roles, including the Organizer; disclose an actual runtime mismatch before model work.

## Prepare and run

1. **Prepare.** Follow [initialization.md](references/initialization.md) for the common base, the Actor template with its empty slot, the Ontologist State, the training request with its judge settings, and the public benchmark brief. Record versions, task order, roles, budgets, resource limits and the selection rule in `experiment.yaml`. Use the requested output directory, otherwise this Session's workspace or scratchpad.
2. **Launch training.** Use the published adapter and CLI with the Ontologist State archive, explicit identity/runtime and benchmark limits. Launch one continuous training trial per independent unit; attempts and experiments run inside it, not as Harbor repetitions.
3. **Monitor.** Save each launch configuration, State digest, job/trial path and process handle in `state.yaml`. Use the runtime's background mechanism with completion notifications. On resume, reconcile live processes and native results before launching missing work.
4. **Collect.** From the trial's `artifacts/submission/`, take `skill/` (the exported slot) and `ontology-records/`. Re-run `node scripts/onto.mjs validate <records>/slot --corpus <records>/corpus --work <records>`; it must pass. Check that `skill/ONTOLOGY.md` equals the full slot's view. Incomplete or failing records mean the experiment is incomplete, not permission to export a convenient subset.
5. **Test.** Freeze the exported slot before any test starts. Build the baseline and final States from the same base (initialization.md, *Test States*), then schedule a complete case × repetition matrix for each, each cell in a fresh environment and conversation. Test feedback never changes the ontology.
6. **Report.** Follow [evaluation.md](references/evaluation.md) and its [common report fields](references/evaluation.md#common-report-fields), with `method: ontology`. Add the measures below.

Follow the benchmark's retry policy, preserving failed attempts and distinguishing infrastructure failures from scored outcomes. Do not retry a completed answer because its score is low.

## What to report beyond the mean

The mean shows whether the ontology helps; these show whether it helps for the stated reason. `onto.mjs summary` computes the training ones from the records. Never tune anything on them.

| Measure | How |
| --- | --- |
| Train − test gap | The `verify` mean minus the final test mean, per unit. |
| Composite transfer | Gain over baseline on the composite test case (`test-005` on GDPevo-essential) ÷ mean gain on the other test cases. |
| Harm | Test cases whose final mean is below the baseline mean. |
| Refuted before deployment | Rules an experiment retired, so that no Actor ever read them. |
| Replication | Per rule: reproduced, held, not reproduced or harm, with the fields that moved. |
| Feedback cost | Judge calls per task, and experiments by outcome (confirmed, refuted, inconclusive, compared). |
| Uptake | `verify` mean against `baseline` mean; decided fields the Actor still got wrong. |
| Use | Per element, how many test Sessions listed it in `ontology-used.txt`; elements never used. |
| Curve | `curve_kind: benchmark_score`, step 0 = `baseline`, step 1 = `verify`. |
| Ontology | Elements per kind and status, and tokens of the rendered view. |

Report per-case paired differences against the baseline with bootstrap intervals over repetitions.

## Method adaptations

Record these in `experiment.yaml` and the report:

- The ontology is read through a fixed reader Skill and a conditional `AGENTS.md` line, not injected into the system prompt.
- The Ontologist is the training session's main Agent on the experiment's model; it is not a separate model.
- Training feedback is the judge's score for a submitted answer, which the benchmark exposes for training. Experiments submit edited copies of the Actors' answers; the exported training answers are the Actors' own. Rubrics, reference answers and verifier output are never read.
- Selection is `final`.
