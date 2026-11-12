---
name: ontology-rsi-toolkit
description: Organize Ontology RSI experiments on published Benchmarks - train a typed domain model (entities, relations, lifecycles, source precedence, action contracts, constraints) from Actor Traces through evidence-gated edits, freeze it, and compare it with the baseline on independent tests.
version: 2026.11.12.1
---

# Ontology RSI

Design: [DESIGN.md](https://github.com/EonHao/ontology-rsi-toolkit/blob/main/DESIGN.md). Training tasks and test tasks of a Benchmark share a domain, not a task. This toolkit learns that domain as a typed model kept in the Target's own State, `skills/domain-ontology/`. An Ontologist proposes typed edits after every attempt, and a deterministic script ([onto.mjs](scripts/onto.mjs)) publishes only edits that quote the Trace verbatim, keep references intact, name no instance of a single task and fit the token budget. Policy enters as a `candidate` and becomes `active` only on support from two distinct tasks or an improved retry. Model weights, tools and the harness stay fixed.

This is the outside experiment Organizer's entry point. The Organizer prepares and launches runs, collects artifacts and reports results. Inside each training environment, a continuing main Agent is the Ontologist: it delegates each task attempt to a fresh Actor session, reads that attempt's Trace and judge reply, and edits the ontology. Install [training.md](references/training.md) there as `ontology-training`. Actors and test solvers receive only the solving instruction and their frozen slot.

## Before you start

Read [benchmark.md](references/benchmark.md) to discover the selected Project's published Train/Test packages and their run contracts. Use the user's benchmark, source version, runtime, output location and budgets when supplied; otherwise resolve them from the current Environment and package instructions. Ask only for essentials that cannot be resolved.

| Setting | Default |
| --- | --- |
| Independent training runs per benchmark/training unit | 1 |
| Passes over the training tasks, P | 2; pass 2 retries every task under the pass-1 ontology |
| Attempts per task per pass | 1 |
| Ontology token budget (rendered view) | 6000 |
| Edit repairs after a rejection, per attempt | 1 |
| Checkpoint selection | `final`: the last published ontology |
| Test conditions | Baseline and the final ontology |
| Complete test repetitions per condition | 3 |
| Harbor trial concurrency | 4, shared across owned training and testing jobs |

These are toolkit choices, not constants of a paper. Fix the configuration before learning. Use sorted public task ids unless another order is supplied. Five tasks and P=2 mean 10 fresh Actor sessions and 10 judge calls in one training run; five held-out tasks and three repetitions mean 15 test trials per condition, 30 with the baseline. When the experiment reuses a published baseline, record its source, State digest and versions and confirm they match this experiment's runtime and task commit; otherwise measure it.

Resolve provider, model and thinking level for Organizer, Ontologist, Actor and test solver. Actor and test solver settings must match. Honor requests for the same model in all roles, including the Organizer; disclose an actual runtime mismatch before model work.

## Prepare and run

1. **Prepare.** Follow [initialization.md](references/initialization.md) for the common base, the Actor template with its empty slot, the Ontologist State, the training request and the public benchmark brief. Record versions, task order, roles, budgets, resource limits and the selection rule in `experiment.yaml`. Use the requested output directory, otherwise this Session's workspace or scratchpad.
2. **Launch training.** Use the published adapter and CLI with the Ontologist State archive, explicit identity/runtime and benchmark limits. Launch one continuous training trial per independent unit; passes and attempts run inside it, not as Harbor repetitions.
3. **Monitor.** Save each launch configuration, State digest, job/trial path and process handle in `state.yaml`. Use the runtime's background mechanism with completion notifications. On resume, reconcile live processes and native results before launching missing work.
4. **Collect.** From the trial's `artifacts/submission/`, take `skill/` (the exported slot) and `ontology-records/`. Re-run `node scripts/onto.mjs validate <records>/slot --corpus <records>/corpus` on the full slot; it must pass. Check that `skill/ONTOLOGY.md` equals the full slot's view and that the exported version is the last published one. Incomplete or failing records mean the experiment is incomplete, not permission to export a convenient subset.
5. **Test.** Freeze the exported slot before any test starts. Build the baseline and final States from the same base (initialization.md, *Test States*), then schedule a complete case × repetition matrix for each, each cell in a fresh environment and conversation. Test feedback never changes the ontology.
6. **Report.** Follow [evaluation.md](references/evaluation.md) and its [common report fields](references/evaluation.md#common-report-fields), with `method: ontology`. Add the measures below.

Follow the benchmark's retry policy, preserving failed attempts and distinguishing infrastructure failures from scored outcomes. Do not retry a completed answer because its score is low.

## What to report beyond the mean

The mean shows whether the ontology helps; these show whether it helps for the stated reason (DESIGN.md, *Hypotheses*). Compute them from the frozen matrices and the training records; never tune anything on them.

| Measure | How |
| --- | --- |
| Train − test gap | Mean of the last training pass minus the final test mean, per unit. |
| Composite transfer | Gain over baseline on the composite test case (`test-005` on GDPevo-essential) ÷ mean gain on the other test cases. |
| Harm | Test cases whose final mean is below the baseline mean. |
| Use | Per element, how many test Sessions listed it in `ontology-used.txt`; elements never used. |
| Curve | Mean training score per pass (`curve_kind: benchmark_score`, step = pass, `native_stage` = `P1`, `P2`). |
| Ontology | Elements per kind and status, tokens of the rendered view, edits applied and rejected with reasons. |

Report per-case paired differences against the baseline with bootstrap intervals over repetitions.

## Method adaptations

Record these in `experiment.yaml` and the report:

- The ontology is read through a fixed reader Skill and a conditional `AGENTS.md` line, not injected into the system prompt.
- The Ontologist is the training session's main Agent on the experiment's model; it is not a separate model.
- Training feedback is the judge's score and correctness feedback, which the benchmark exposes for training. Rubrics, reference answers and verifier output are never read.
- Selection is `final`; pass 2 is both a retry signal for promotion and the last training measurement.
