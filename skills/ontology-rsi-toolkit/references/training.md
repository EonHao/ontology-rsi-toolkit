---
name: ontology-training
description: Run the Ontology RSI loop as the Ontologist inside one continuing training environment - baseline attempts, a map of where credit is lost, rules tested by experiment on the judge and then reproduced by fresh Actors, and export of the final slot.
version: 2026.11.12.5
---

# Ontology training

Read `training-request.json` at the Agent State root, then `benchmark-training.md` and `ontologist.md` beside this Skill. The request gives the ordered tasks, budgets, the judge settings, the Actor's identity and runtime, and the export paths. The outside Organizer handles deployment and testing.

You are the Ontologist. You learn a typed model of this domain, and every rule in it passes two gates. An experiment on the judge shows that the value the rule gives earns credit; no Actor reads a rule before that. Then a fresh Actor, given only the rule, must gain that credit itself; a rule that cannot be reproduced is not knowledge the next task can use. You never solve a task for the Actor and never write a final answer. Everything that changes the ontology or touches the judge goes through the script, which keeps the records.

```text
STATE   = this Agent State (where training-request.json sits)
SCRIPT  = <node> STATE/skills/ontology-training/onto.mjs   (<node>: `node` on PATH, else the Node.js the brief names)
CONFIG  = STATE/training-request.json                      (holds the judge settings)
PROJECT = <app_data_dir from your Environment section>
ACTOR   = PROJECT/agents/<actor.agent_id>
WORK    = paths.work from the request
SLOT    = WORK/slot          the working ontology, with provenance
CORPUS  = WORK/corpus        what extract pulled from Traces
```

Every call to the judge is recorded, plain `judge` scores included, and the report counts them. Pass `--config CONFIG --work WORK` to every `judge`, `localize`, `experiment`, `replicate` and `apply` call, and `--snapshots WORK/snapshots` to `apply`, `experiment` and `replicate`. Always the absolute `WORK` from the request: the script refuses any other work directory, so that one run keeps one set of records.

## Set up

1. Create the Actor: `penguin agent create --agent-id <actor> --project-id <project> --json`. Copy the template's files into `ACTOR/agent_state/`, keeping the runtime's `.vault.toml`.
2. Copy the template's `skills/domain-ontology/` to `SLOT`. `SCRIPT validate SLOT` must pass. Copy `SLOT/ontology.json` to `WORK/snapshots/v0.json`.
3. Create `WORK/attempts`, `WORK/variants`, `WORK/edits` and `WORK/logs`.

## An attempt

An attempt is one fresh Actor session on one task. Phases 1 and 4 use it.

1. **Install** the deployable copy of the current ontology: remove `ACTOR/agent_state/skills/domain-ontology`, then `SCRIPT export SLOT ACTOR/agent_state/skills/domain-ontology`.
2. **Dispatch** with `run_subagent`, setting the Actor's `agent_id`, `provider`, `model_id` and `thinking_level` explicitly, and only this prompt, filled from the brief:

   ```text
   Caller agent: <your agent id>.
   Complete training task <t>. Its instruction and inputs are <public paths
   from the brief>; access to the business environment is described in
   <access file>. Write your final answer, in the task's required format, to
   WORK/attempts/<t>-<phase>.json instead of the path the instruction names.
   Do not call any judge or scoring endpoint.
   When you are done, end your reply with the line "session: <your Session ID>".
   ```

   Never include earlier answers, scores, your diagnoses or this conversation. If `run_subagent` returns a `subagent_id` before the Actor finishes, poll it with `input_subagent` (empty prompt); never steer it, and run one attempt at a time.
3. **Score and observe.** Do not edit the answer.

   ```bash
   SCRIPT judge --task <t> --answer WORK/attempts/<t>-<phase>.json --phase <phase> --session <sid> --slot SLOT --config CONFIG --work WORK
   SCRIPT extract --session <sid> --agent-dir ACTOR --task <t> --out CORPUS \
     --used ACTOR/scratchpad/<sid>/ontology-used.txt --log WORK/logs/<t>-<phase>.log
   ```

   If the reply has no `session:` line, take the newest root Trace under `ACTOR/traces/` created after the dispatch. If the log shows the Actor calling the judge, or its installed slot differs from a fresh export, record the attempt as invalid in `state.json` and do not learn from it.

## Phase 1: baseline

Run one attempt per task, in the request's order, with phase `baseline`. The slot is still empty, so these scores are what the agent does without the ontology, and their answers are the material for every experiment.

## Phase 2: map

```bash
SCRIPT localize --task <t> --answer WORK/attempts/<t>-baseline.json --config CONFIG --work WORK   # each task
SCRIPT gaps --work WORK
```

`localize` removes one answer field at a time and asks the judge again; in a list of records it goes record by record (`rows[2].status`). A field whose removal costs points earned credit; a field whose removal changes nothing earned none: it is wrong, it is not scored, or it is scored only together with others. For true/false fields the script settles which: it flips the value, and reports the field as `wrong` if the score rises and `unscored` if nothing moves. `gaps` drops the unscored fields and lists the rest under one path per field (`rows.status`), the ones that recur across the most tasks first, with how often the field was proved wrong and how often the same field earned credit elsewhere, which shows that it is scored at all. Work in that order. A gap shared by many tasks is a fact about the domain and will meet the next task too; a gap in one task may be that task's own.

Then record the structure the Actors relied on (`ontologist.md`, *Structure*) with one `apply`. Keep it lean: the records and fields the gaps touch, and the sources an Actor wasted calls finding.

## Phase 3: hypothesize and test

For each gap, top down, follow `ontologist.md`:

1. State what you think the field must be as a policy element that `decides` it, and `apply` it. It enters as a hypothesis, invisible to the Actor.
2. Build a variant: copy a judged answer to `WORK/variants/`, and change only the decided fields to what the rule says for that task's records.
3. Run the experiment. The prediction is part of the command, so you commit to it before the judge answers:

   ```bash
   SCRIPT experiment SLOT --task <t> --base <judged answer> --variant <variant> \
     --tests <element id>... --predict better|worse --config CONFIG --work WORK --snapshots WORK/snapshots
   ```

   - `confirmed`: the element becomes active and is published.
   - `refuted`: a single tested element is retired, and the record stays. State a different rule under a new id.
   - `inconclusive`: nothing moved. The field may be scored only together with others: test the elements that decide the whole section as one bundle, and use plain comparisons (`experiment` without `--tests`) to find which parts matter.
4. Repeat the experiment in every other task the rule applies to, building each variant from the rule's text and that task's records, never from what scored well elsewhere. Each task that confirms it adds to its support; one that refutes it retires it.

Exploring a gap with plain comparisons is fair: it shows which values earn credit. It proves nothing about a rule you write afterwards to fit them. Phase 4 does, so write each rule as an instruction a stranger could follow, not as a description of the answer you found.

Stop a gap when it is closed in every task it appears in, when its judge budget is spent, or when three different rules have been refuted and you have no better idea; note what is left open in `state.json`. Leave phase 3 when the gaps are done or two thirds of `time_budget_minutes` have passed.

Before phase 4, run the export once (see *Export*). If the session ends early, what you have proved so far is already delivered.

## Phase 4: reproduce

An experiment shows that a value is right. It does not show that the rule you wrote produces it. Run one attempt per task with phase `verify` on the published ontology: these Actors have the rules and nothing else. Then: Every task gets a `verify` attempt: a rule tested only in tasks without one has never been replicated, and `replicate` takes it out of the view.

```bash
SCRIPT replicate SLOT --config CONFIG --work WORK --snapshots WORK/snapshots
```

It compares each task's `baseline` and `verify` answers field by field, and judges every rule in the tasks where its experiment passed:

- `reproduced`: the Actor gained credit on a field the rule decides. The rule stays, marked as reproduced.
- `held`: the fields had credit before and after. The rule stays, with no gain shown.
- `not reproduced`: the fields had no credit before or after. The rule goes back to hypothesis and leaves the view. The value is right, so the wording failed: rewrite the rule so that a stranger could follow it (which records, selected how, in which order), confirm it again by experiment, and make another `verify` attempt for that task if time allows.
- `harm`: a field that had credit lost it. The rule is retired.

Run `replicate` again after any repeated attempt. Every `verify` attempt made under a rule's current text counts for that rule: a field is gained only if every one of them has it, and lost if any lacks it, so a retry never erases a loss. Attempts made before a rule was rewritten no longer count for it. Make another attempt only after rewriting a rule, never to try again under the same text. `replicate` knocks out only the fields that deployed rules decide, and its calls are measurements, not search, so the judge budget does not apply to them: never skip a task's replication because of the budget.

Every attempt an Actor makes on the published ontology is a `verify` attempt, whatever its score. The script accepts no other phase label. An attempt that scores below the baseline is the evidence this phase exists to find; recording it under another name, or leaving it out, would deploy the rule that caused it.

Never rerun an attempt because its score is low, and never hand an Actor a variant.

## Time

Before each attempt and each new gap, compare elapsed session time with `time_budget_minutes − reserve_minutes`. Phase 4 needs about as long as phase 1 took; start it early enough. If time runs out before phase 4, export anyway and say so.

## Export

```bash
SCRIPT finish SLOT --work WORK --corpus CORPUS --skill <paths.skill_export> --answers <paths.answers>
```

One command validates the slot, writes the deployable copy, copies each task's last attempt, unchanged, as its final answer (its last `verify` attempt when there is one, else the `baseline` one; a variant is never a final answer) and writes `WORK/summary.json`. It must print `"ok": true`. Run it at the end of phase 3 and again as your last step; a later run replaces an earlier export.

`WORK` sits under the submission folder and is exported with it. End with a short report: baseline and verify means, the rules reproduced, held, not reproduced and refuted, the gaps left open, judge calls per task, and every failure.

## What keeps the measurement honest

- The Actor sees only the public task, the access brief and its frozen slot.
- Only the script changes `SLOT` and only the script asks the judge. Never call the judge endpoint yourself, and never edit `ontology.json`, `ONTOLOGY.md`, `SKILL.md`, the corpus or the records by hand.
- The export folder (`paths.skill_export`) is written by `finish` alone. `finish` removes any other file from it, and the Organizer deploys a fresh export of the validated slot, not the folder. Write notes, recipes and playbooks into `WORK` if you want them kept for the report; they never reach the Target.
- A variant is evidence about a rule, built from the rule. Searching answer values until the score rises, with no rule that produces them, teaches nothing that transfers: do not do it.
- Read nothing under `rubric/`, `solution/` or `tests/`, and no verifier output.
- The script blocks instance ids it can recognize. You keep out everything else that makes sense for one case only: dates, amounts, names, answer values.
