---
name: ontology-training
description: Run the Ontology RSI loop as the Ontologist inside one continuing training environment - fresh Actor attempts, judge feedback, evidence-gated edits to a typed domain model, and export of the final slot.
version: 2026.11.12.1
---

# Ontology training

Read `training-request.json` at the Agent State root, then `benchmark-training.md` and `ontologist.md` beside this Skill. The request gives the ordered tasks, passes, budgets, the Actor's identity and runtime, and the export paths; the brief gives the public inputs, the judge call and the score scale. The outside Organizer handles deployment and testing.

You are the Ontologist. You do not solve tasks, draft answers or hint at them. Each attempt goes to a fresh Actor session; you read what it did and what the judge said, and you change the ontology only through the script.

```text
STATE   = this Agent State (where training-request.json sits)
SCRIPT  = node STATE/skills/ontology-training/onto.mjs
PROJECT = <app_data_dir from your Environment section>
ACTOR   = PROJECT/agents/<actor.agent_id>
WORK    = paths.work from the request
SLOT    = WORK/slot          the working ontology, with provenance
CORPUS  = WORK/corpus        what extract pulled from Traces and judge replies
RECORDS = WORK/records.jsonl one line per attempt
```

Keep `WORK/state.json` current (pass, task index, next attempt number, last published version) so that a compacted session resumes the run instead of restarting it.

## Set up

1. Create the Actor: `penguin agent create --agent-id <actor> --project-id <project> --json`. Copy the template's files into `ACTOR/agent_state/`, keeping the runtime's `.vault.toml`.
2. Copy the template's `skills/domain-ontology/` to `SLOT`. `SCRIPT validate SLOT` must pass. Copy `SLOT/ontology.json` to `WORK/snapshots/v0.json`.
3. Create `WORK/attempts`, `edits`, `apply`, `logs` and `snapshots`.

## One attempt

Attempts are numbered 1, 2, … across the run. For attempt `n` on task `t`:

1. **Install.** Replace the Actor's slot with the deployable copy of the current ontology: remove `ACTOR/agent_state/skills/domain-ontology`, then `SCRIPT export SLOT ACTOR/agent_state/skills/domain-ontology`. Record the installed version.
2. **Dispatch.** Call `run_subagent` with the Actor's `agent_id`, `provider`, `model_id` and `thinking_level` set explicitly, and only this prompt, filled from the brief:

   ```text
   Complete training task <t>. Its instruction and inputs are <public paths
   from the brief>; access to the business environment is described in
   <access file>. Write your final answer, in the task's required format, to
   WORK/attempts/<t>-<n>.json. Do not call any judge or scoring endpoint.
   When you are done, end your reply with the line "session: <your Session ID>".
   ```

   Never include earlier answers, scores, judge replies, your diagnoses or this conversation.
3. **Judge.** Do not edit the candidate. Call the training judge once, as the brief says, with that candidate, and save the raw reply to `WORK/attempts/<t>-<n>.judge.json`. Convert the score to 0–100. A failed judge call is not a scored zero: record it and do not count the attempt in any mean.
4. **Integrity.** Export the same version to a scratch folder and compare it with the Actor's installed copy. A difference means the Actor edited its slot: record it and do not use that attempt as support.
5. **Extract.** If the reply has no `session:` line, take the newest root Trace under `ACTOR/traces/` created after the dispatch.

   ```bash
   SCRIPT extract --session <sid> --agent-dir ACTOR --task <t> --out CORPUS \
     --used ACTOR/scratchpad/<sid>/ontology-used.txt --log WORK/logs/<t>-<n>.log
   SCRIPT extract-judge --response WORK/attempts/<t>-<n>.judge.json \
     --task <t> --attempt <n> --out CORPUS
   ```

6. **Propose.** Read `WORK/logs/<t>-<n>.log`, the judge reply, `SLOT/ONTOLOGY.md` and, where you need exact values, the corpus file. Follow `ontologist.md` and write `WORK/edits/<t>-<n>.json`. An empty list is a valid proposal.
7. **Apply.**

   ```bash
   SCRIPT apply SLOT WORK/edits/<t>-<n>.json --corpus CORPUS \
     --snapshots WORK/snapshots > WORK/apply/<t>-<n>.json
   ```

   For rejections with a mechanical cause (a quote copied with a typo, an ADD that must come before the edit referring to it), fix only those operations and apply them as `<t>-<n>.r1.json`, at most `edit_repairs` times. Never answer a rejection by inventing a quote, dropping the evidence, or rewording content so that the barrier stops matching an instance id.
8. **Record.** Append to `RECORDS`: pass, task, attempt, session, installed version, score, judge status, used ids, integrity, published version, applied and rejected operations with reasons, auto-retired ids, start and end times.

## Order, passes and time

Run pass 1 over the tasks in the request's order, then pass 2 in the same order, one attempt per task per pass, sequentially. In pass 2, credit elements from the Actor's `ontology-used.txt` against that task's pass-1 score (`SUPPORT … use: {score, prev_score}`); the script promotes a candidate only on a real improvement.

Before each attempt, compare elapsed session time with `time_budget_minutes − reserve_minutes`. If what remains is less than 1.5 × the longest attempt so far, stop launching, record the stop, and export. A complete pass 1 is the minimum valid handoff. Never add attempts, reorder tasks or rerun an attempt because its score is low.

## Probes

You may test a hypothesis about structure against the business service with read-only queries. Run them yourself, then extract your own Session as task `probe`:

```bash
SCRIPT extract --session <your Session ID> --agent-dir PROJECT/agents/<your agent id> \
  --task probe --out CORPUS
```

Probe quotes can ground fields, keys, enums and relations. They never count as task support, and a probe never looks for a task's answer.

## Export

1. `SCRIPT validate SLOT --corpus CORPUS` must pass.
2. `SCRIPT export SLOT <paths.skill_export>`.
3. For each task, copy the candidate of its last scored attempt, unchanged, to `<paths.answers>/<task>.json`.
4. Write `WORK/summary.json`: completed passes and the mean training score of each complete pass, the exported version, `SCRIPT stats SLOT`, applied and rejected totals, and any stop reason.

`WORK` sits under the submission folder and is exported with it. End with a short report: passes completed, per-pass means, the exported version, elements per kind and status, and every failure.

## What keeps the measurement honest

- The Actor sees only the public task, the access brief and its frozen slot.
- Only you change `SLOT`, and only through `SCRIPT apply`. Never edit `ontology.json`, `ONTOLOGY.md`, `SKILL.md` or the corpus by hand.
- Judge replies are feedback for you, never for the Actor. Read nothing under `rubric/`, `solution/` or `tests/`, and no verifier output.
- The script blocks instance ids it can recognize. You keep out everything else that makes sense for one case only: dates, amounts, names, answer values.
