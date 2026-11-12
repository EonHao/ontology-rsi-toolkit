# Prepare the experiment

Resolve the Project from the Penguin Environment's App Data Dir. Use the requested output location, otherwise this Session's workspace or scratchpad. Organizer-created configurations, staging copies, archives and reports belong there. Runtime-managed Agent files and Harbor trials keep their normal locations.

Assign a stable experiment/report version. Record the actual Harness, toolkit, runner and benchmark package versions, the resolved source commit, local source changes, provider/model/thinking per role, budgets, task order, limits and the selection rule. Add State versions and digests as they are frozen. Keep a launch index in `state.yaml` for recovery after compaction.

`SCRIPT` below is this Skill's `scripts/onto.mjs`. It needs Node and nothing else.

## Common base

Use the supplied base Agent or create a fresh identity through the CLI:

```bash
penguin agent create --agent-id <unused-id> --project-id <project-id> --json
```

The measured base is separate from the Organizer. Preserve a supplied Agent's unrelated State and snapshots. Make experiment-specific copies without learned business Skills, old answers or experiment history; disable persistent memory and state-mutating hooks in these copies. Align State turn limits, including `compaction.max_session_turns: -1`, and runner limits with the benchmark. Keep tools and runtime fixed. Snapshot the base before adding anything.

Put this solving instruction in the base's `AGENTS.md`, so every State built from it carries it:

```text
Complete the supplied benchmark task. Follow the supplied task's input and
output contract.
```

## Actor template and the empty slot

Copy the base to an Actor template and initialize the slot there:

```bash
node SCRIPT init <template>/skills/domain-ontology --agents-md <template>/AGENTS.md
```

This writes `SKILL.md` (the fixed reader), an empty `ontology.json`, its rendered `ONTOLOGY.md` and `CHANGELOG.md`, and appends one conditional reader line to `AGENTS.md`:

```text
If skills/domain-ontology/SKILL.md is installed in your Agent State, read it
before your first substantive action in any task and follow it.
```

Do not seed the slot with domain knowledge, examples or answers. `node SCRIPT validate <template>/skills/domain-ontology` must pass. Record the template digest; it is H1 for this toolkit.

## Ontologist training State

Copy the base into a separate Ontologist State and install:

| Source | Destination relative to the Ontologist State |
| --- | --- |
| `references/training.md` | `skills/ontology-training/SKILL.md` |
| `references/ontologist.md` | `skills/ontology-training/ontologist.md` |
| `scripts/onto.mjs` | `skills/ontology-training/onto.mjs` |
| Prepared Actor template | `skills/ontology-training/assets/actor-state/` |
| Public benchmark training brief | `skills/ontology-training/benchmark-training.md` |
| Resolved run configuration | `training-request.json` |

The brief gives the public task and input paths, API and tool access, the judge call and how to read its reply, score interpretation, state reset semantics, and the export paths for answers, the Skill and records. Derive these from the selected benchmark, not from hard-coded group paths. Confirm that the training judge is enabled; a reachable business API alone is not enough.

`training-request.json`, with every path resolvable inside the container:

```json
{
  "experiment_version": "<version>",
  "benchmark_id": "<train package id>",
  "unit": "<training unit id>",
  "tasks": ["train_001", "train_002", "train_003", "train_004", "train_005"],
  "passes": 2,
  "budget_tokens": 6000,
  "edit_repairs": 1,
  "selection": "final",
  "time_budget_minutes": 360,
  "reserve_minutes": 30,
  "actor": {
    "agent_id": "<actor id>",
    "project_id": "<project id in the container>",
    "provider": "<provider>",
    "model_id": "<model>",
    "thinking_level": "<level>",
    "template": "skills/ontology-training/assets/actor-state"
  },
  "paths": {
    "work": "/app/submission/ontology-records",
    "skill_export": "/app/submission/skill",
    "answers": "/app/submission/answers"
  }
}
```

The request names no held-out material and no test repetitions; those belong to the Organizer's schedule. Add to the Ontologist's `AGENTS.md`:

```text
For this whole training run, read training-request.json beside this file,
skills/ontology-training/SKILL.md and its benchmark-training.md. Run the
loop as the Ontologist in this continuing session and business environment.
Create the supplied Actor identity from the Actor template and use fresh
run_subagent sessions with that identity for the task attempts.
```

## Test States and archives

After complete training, prepare two States from the same base:

- **baseline**: the base, plus the conditional reader line, with no slot. A reused published baseline must match this definition up to the conditional line, which is inert without a slot; record any difference.
- **final**: the base, the conditional reader line, and the exported slot (`skill/` from the training submission) installed as `skills/domain-ontology/`.

Training instructions, the Actor template, answers, records and conversations do not enter test States. Snapshot versions and digests, and reuse each frozen archive for every repetition, restoring it into a fresh environment and session per case. For Penguin's Harbor adapter the archive root holds the State files directly:

```bash
tar --exclude=./.vault.toml --exclude=./memory --exclude=./schedule \
  -czf "$STATE_TAR" -C "$STATE_DIR" .
```

Bind `agent_state_tar`, agent/project identity, runtime and model configuration through the adapter's documented arguments. Credentials travel through its private configuration mechanism, never prompts or archives. Use the Benchmark's normal executable installation unless the experiment requests a source build; then record the source commit and bundle digest and reuse that build throughout.
