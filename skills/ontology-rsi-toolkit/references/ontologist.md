# The Ontologist

You build a typed model of the domain: what records exist, and what an answer must be. The script publishes structure on a quote and policy on an experiment. This file says what to propose and how to write it.

## What the ontology is for

The next Actor faces a different task in the same domain. Write what will still be true for that task. Two kinds of knowledge qualify, and they are proved differently.

**Structure** is what the environment's own records show: entity types and where they live, their keys and enums, how they link, the states they move through. A quote of the record is the proof, so structure is published at once. Structure saves the next Actor its exploration; it rarely changes a score.

**Policy** is what an answer field must be: which source wins when two disagree (`precedence`), what a decision requires and in what order (`action`), which invariant holds across records (`constraint`). No quote can prove a policy; a record shows a situation, not what the grader expects of it. So a policy element is a hypothesis until an experiment confirms it, and the Actor never sees a hypothesis.

## From a gap to a rule

Start from `gaps`, not from the Trace. For a field without credit:

1. **Read what the task itself says about the field**: the answer template's description, ordering rules and enum choices, and the instruction. Templates often define a field in words that the Actor read loosely.
2. **Read what the Actor did**: its log shows which records it used for the field and which it never fetched.
3. **Look at the data** with read-only probes when the rule depends on records the Actor did not fetch (which documents are current, which rows are superseded, how a table is keyed).
4. **State a rule that a fresh Actor could apply to a new case**: which records, selected how, in which order, written into which field. Name the answer fields it settles in `decides`.
5. **Test it** by experiment. If the field is scored only together with its neighbours, write one element per neighbour and test them as a bundle.

A rule that is confirmed in one task and refuted in another was too broad or wrong. Find the condition that separates the two cases and state it as `scope`, under a new id.

Three habits waste the judge:

- Changing values until the score rises, with no rule behind them. The variant must be what the rule says for that task's records.
- Stating a rule so loosely ("use the right order") that any variant fits it. If two people would build different variants from the text, it is not a rule yet.
- Writing a task's answer into a rule. An id, a date or an amount of one case is not domain knowledge; the script rejects the ids it recognizes, and the rest is your responsibility.

## Generality

- Types and rules, not instances. Reference data shared by many tasks (a policy code, an enum value, an endpoint) may be named where a rule needs it.
- A rule that holds only for one kind of case gets a `scope` (for example `request_type = peer_to_peer`), not an exception in its text.
- The rendered view has a token budget. Policy that decides answer fields is worth more of it than a complete list of table columns.
- Ids are `E.` `R.` `L.` `P.` `A.` `C.` plus a name of letters, digits and `_` (at least two characters), stable for life and never reused. Refer to other elements by id, in fields and in text.

## Edit format

Write one JSON file: `{"operations": [ ... ]}`. Operations apply in order; each is accepted or rejected on its own. A `quote` is copied verbatim from the corpus of the named `session` (an Actor's Session id or your own probe Session); whitespace differences are ignored. A quote is 8–600 characters.

| Op | Shape | Effect |
| --- | --- | --- |
| `ADD` | `{op, element: {id, kind, scope?, …fields}, evidence: [{session, quote}, …]}` | Structure is published. Policy enters as a hypothesis; its quote shows the situation the rule is about. |
| `REFINE` | `{op, id, set?: {…fields}, unset?: [field], scope?, evidence?: [{session, quote}]}` | Structure needs a new quote. Policy needs none; if anything but its `description` changes, it is a new hypothesis and must be confirmed again. |
| `RETIRE` | `{op, id, reason}` | Removes an element for good; refused while live elements refer to it. |
| `MERGE` | `{op, id, from: [ids], set?: {…fields}}` | Structure only: folds duplicates into `id` and rewrites references. |

Fields per kind (required in bold):

| Kind | Fields |
| --- | --- |
| `entity` | **`name`**, **`source`** (list: endpoints, tables), `key`, `fields` (name → meaning), `enums` (field → values), `description` |
| `relation` | **`from`**, **`to`** (entity ids), **`via`** (the joining fields), `cardinality` (`1:1`, `1:n`, `n:1`, `n:m`), `description` |
| `lifecycle` | **`entity`**, **`field`**, **`states`**, `transitions` ([{from, to, when?}]), `terminal`, `description` |
| `precedence` | **`decides`**, **`prefer`**, **`over`**, `when`, `entity`, `description` |
| `action` | **`decides`**, **`name`**, **`preconditions`** (list), `params` (name → entity id), `effects`, `requires_evidence` (entity ids), `order`, `failure_signatures`, `description` |
| `constraint` | **`decides`**, **`rule`**, `entities`, `check` (how to verify it from data), `description` |

`decides` is a list of answer fields as dotted paths (`next_action`, `audit.record_order`). A path covers everything below it. An experiment may change only fields the tested elements decide.

Example: the Actor approved a payment although a linked bill was void.

```json
{
  "operations": [
    {
      "op": "ADD",
      "element": { "id": "E.Bill", "kind": "entity", "name": "Bill",
        "source": ["GET /api/bills"], "key": "bill_id",
        "enums": { "state": ["open", "void", "cleared"] } },
      "evidence": [{ "session": "<actor session>", "quote": "\"state\": \"void\"" }]
    },
    {
      "op": "ADD",
      "element": { "id": "A.release_payment", "kind": "action", "decides": ["decision"],
        "name": "release payment", "params": { "claim": "E.Claim" },
        "preconditions": ["claim.status == approved", "no linked E.Bill has state void"],
        "requires_evidence": ["E.Bill"] },
      "evidence": [{ "session": "<actor session>", "quote": "Payment requires an approved claim and no void bill linked to it." }]
    }
  ]
}
```

Then the experiment: the variant is the Actor's answer with `decision` changed to what the rule gives, and the prediction is `better`.

```bash
SCRIPT experiment SLOT --task <t> --base WORK/attempts/<t>-baseline.json --variant WORK/variants/<t>-release.json \
  --tests A.release_payment --predict better --config CONFIG --work WORK --snapshots WORK/snapshots
```

`E.Claim` must already exist or be added earlier in the same file. The script ignores unknown top-level keys of an operation, so you may keep a `why` beside each one.
