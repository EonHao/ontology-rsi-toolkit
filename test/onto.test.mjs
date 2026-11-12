// Tests of the deterministic toolkit script. Run: node --test "test/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  AGENTS_LINE,
  READER_BODY,
  applyEdits,
  changedPaths,
  diffOntologies,
  exportSlot,
  extractTrace,
  finish,
  gaps,
  initSlot,
  judgeAnswer,
  judgeCalls,
  leafPaths,
  loadCorpus,
  loadSlot,
  localize,
  nextSkillVersion,
  replicate,
  runExperiment,
  summarize,
  traceFiles,
  validateSlot,
  writeCorpus,
} from "../skills/ontology-rsi-toolkit/scripts/onto.mjs";

const SCRIPT = fileURLToPath(new URL("../skills/ontology-rsi-toolkit/scripts/onto.mjs", import.meta.url));
const DATE = "2026-11-12";
const run = promisify(execFile);

// ---------------------------------------------------------------------------------------------
// Fixtures: two Actor Sessions on two training tasks of one payer domain, and a judge.

const j = (v) => JSON.stringify(v, null, 2);
const POLICY = {
  policy_id: "POL-12",
  title: "Payment release",
  text: "Payment requires an approved claim and no void bill linked to it.",
};

function trace(session, userText, calls, finalText) {
  const recs = [{ type: "session_meta", payload: { session_id: session, agent_state: "/x/agent_state" } }];
  recs.push({ type: "model_msg", payload: { type: "text", role: "user", text: userText } });
  calls.forEach(([name, args, output, status], i) => {
    const id = `call_${i}`;
    recs.push({ type: "model_msg", payload: { type: "tool_call", tool_call_id: id, name, arguments: args } });
    recs.push({
      type: "model_msg",
      payload: { type: "tool_call_output", tool_call_id: id, output, status: status || "completed" },
    });
  });
  // A nested subagent record must be ignored.
  recs.push({
    type: "model_msg",
    origin: ["child"],
    payload: { type: "tool_call_output", tool_call_id: "z", output: "NESTED-999 secret" },
  });
  recs.push({ type: "model_msg", payload: { type: "text", role: "assistant", text: finalText } });
  return recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onto-test-"));
  const agentDir = path.join(root, "agents", "actor");
  const day = path.join(agentDir, "traces", "2026-11-12");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(
    path.join(day, "s1_001.jsonl"),
    trace(
      "s1",
      "Decide whether claim CLM-1001 can be paid. Return JSON only.",
      [
        [
          "exec_command",
          '{"cmd":"curl -s -X POST /sql/query"}',
          j({ rows: [{ claim_id: "CLM-1001", status: "approved", member_id: "M-0077" }], row_count: 1 }),
        ],
        [
          "exec_command",
          '{"cmd":"curl -s /api/bills?claim=CLM-1001"}',
          j({ rows: [{ bill_id: "B-0501", claim_id: "CLM-1001", state: "void" }] }),
        ],
        ["exec_command", '{"cmd":"curl -s /api/policies/POL-12"}', j(POLICY)],
        ["exec_command", '{"cmd":"curl -s /api/nope"}', "HTTP 404 Not Found", "failed"],
      ],
      "The claim is approved, so it can be paid.",
    ),
  );
  fs.writeFileSync(
    path.join(day, "s2_001.jsonl"),
    trace(
      "s2",
      "Decide whether claim CLM-2002 can be paid. Return JSON only.",
      [
        [
          "exec_command",
          '{"cmd":"curl -s -X POST /sql/query"}',
          j({ rows: [{ claim_id: "CLM-2002", status: "pending", member_id: "M-0088" }] }),
        ],
        ["exec_command", '{"cmd":"curl -s /api/policies/POL-12"}', j(POLICY)],
      ],
      "Pending claims cannot be paid.",
    ),
  );
  return {
    root,
    agentDir,
    corpusDir: path.join(root, "work", "corpus"),
    work: path.join(root, "work"),
    slot: path.join(root, "work", "slot"),
  };
}

function extractAll(fx) {
  for (const [session, task] of [
    ["s1", "train_001"],
    ["s2", "train_002"],
  ]) {
    const x = extractTrace(traceFiles(fx.agentDir, session), { session, clip: 1500 });
    writeCorpus(fx.corpusDir, {
      session,
      task,
      kind: "trace",
      used: [],
      instance_ids: x.instance_ids,
      subject_ids: x.subject_ids,
      sources: x.sources,
    });
  }
  return loadCorpus(fx.corpusDir);
}

// The judge: three equally weighted items per task. `audit` is one item, right only as a whole.
const GOLD = {
  train_001: { decision: "deny", hold_reason: "void_bill", audit: { rule: "policy_first", order: ["claim", "bill"] } },
  train_002: { decision: "deny", hold_reason: "pending", audit: { rule: "policy_first", order: ["claim"] } },
};
const CFG = { url: "http://judge.invalid", body: { task_id: "{task}", answer: "{answer}" }, score_path: "score", scale: 100, budget_per_task: null };
let asked = 0;
async function ask(_cfg, task, answer) {
  asked += 1;
  const g = GOLD[task];
  const right = ["decision", "hold_reason", "audit"].filter((k) => JSON.stringify(answer[k]) === JSON.stringify(g[k])).length;
  return { score: right / 3, correct: right === 3 };
}
// What the Actor answered: the decision is wrong in task 1, the audit trail in both.
const BASE = {
  train_001: { decision: "pay", hold_reason: "void_bill", audit: { rule: "claim_first", order: ["bill", "claim"] } },
  train_002: { decision: "deny", hold_reason: "pending", audit: { rule: "claim_first", order: ["claim"] } },
};

const CLAIM = {
  id: "E.Claim",
  kind: "entity",
  name: "Claim",
  source: ["table claims (POST /sql/query)"],
  key: "claim_id",
  enums: { status: ["approved", "pending"] },
};
const BILL = { id: "E.Bill", kind: "entity", name: "Bill", source: ["GET /api/bills"], key: "bill_id" };
const PAY = {
  id: "A.release_payment",
  kind: "action",
  decides: ["decision"],
  name: "release payment",
  params: { claim: "E.Claim" },
  preconditions: ["claim.status == approved", "no linked E.Bill has state void"],
  requires_evidence: ["E.Bill"],
};
const AUDIT = {
  id: "P.policy_first",
  kind: "precedence",
  decides: ["audit"],
  prefer: "the governing policy text",
  over: "the claim's own status",
};
const q1Claim = { session: "s1", quote: '"status": "approved"' };
const q1Bill = { session: "s1", quote: '"state": "void"' };
const q1Policy = { session: "s1", quote: "Payment requires an approved claim and no void bill linked to it." };
const q2Policy = { session: "s2", quote: "Payment requires an approved claim and no void bill linked to it." };

function seeded() {
  const fx = fixture();
  initSlot(fx.slot, { date: DATE });
  const corpus = extractAll(fx);
  const r = applyEdits(
    fx.slot,
    [
      { op: "ADD", element: CLAIM, evidence: [q1Claim] },
      { op: "ADD", element: BILL, evidence: [q1Bill] },
      { op: "ADD", element: PAY, evidence: [q1Policy] },
      { op: "ADD", element: AUDIT, evidence: [q1Policy] },
    ],
    corpus,
    { date: DATE },
  );
  assert.equal(r.published, true, JSON.stringify(r.rejected));
  return { fx, corpus };
}

const el = (fx, id) => loadSlot(fx.slot).onto.elements.find((e) => e.id === id);
const view = (fx) => fs.readFileSync(path.join(fx.slot, "ONTOLOGY.md"), "utf8");
const exp = (fx, spec) => runExperiment(fx.slot, fx.work, CFG, spec, { ask, date: DATE });

// ---------------------------------------------------------------------------------------------

test("init creates the slot; the reader line is appended once", () => {
  const fx = fixture();
  const agents = path.join(fx.root, "state", "AGENTS.md");
  fs.mkdirSync(path.dirname(agents), { recursive: true });
  fs.writeFileSync(agents, "# Agent\n\nBe careful.");
  initSlot(fx.slot, { date: DATE, agentsMd: agents });
  for (const f of ["SKILL.md", "ontology.json", "ONTOLOGY.md", "CHANGELOG.md"])
    assert.ok(fs.existsSync(path.join(fx.slot, f)), f);
  const { skill, onto } = loadSlot(fx.slot);
  assert.equal(skill.front.name, "domain-ontology");
  assert.equal(skill.front.version, "2026.11.12.1");
  assert.equal(skill.body, READER_BODY);
  assert.equal(onto.elements.length, 0);
  fs.rmSync(fx.slot, { recursive: true });
  initSlot(fx.slot, { date: DATE, agentsMd: agents });
  assert.equal(fs.readFileSync(agents, "utf8").split("\n").filter((l) => l === AGENTS_LINE).length, 1);
  assert.throws(() => initSlot(fx.slot, { date: DATE }), /not empty/);
  const v = validateSlot(fx.slot, loadCorpus(undefined));
  assert.equal(v.ok, true, v.errors.join("; "));
});

test("extract keeps user input and tool outputs, drops model text and nested records", () => {
  const fx = fixture();
  const x = extractTrace(traceFiles(fx.agentDir, "s1"), { session: "s1", clip: 50 });
  assert.deepEqual(
    x.sources.map((s) => s.type),
    ["user", "tool_output", "tool_output", "tool_output", "tool_output"],
  );
  assert.ok(!x.sources.some((s) => s.text.includes("so it can be paid")), "model text is not evidence");
  assert.ok(!x.sources.some((s) => s.text.includes("NESTED-999")), "nested records are skipped");
  assert.deepEqual(x.instance_ids, ["B-0501", "CLM-1001", "M-0077", "POL-12"]);
  assert.deepEqual(x.subject_ids, ["CLM-1001"]);
  assert.ok(x.log.some((l) => l.includes("· failed")));
  assert.ok(x.log.some((l) => l.includes("more characters in the corpus")));
});

test("the barrier forbids single-task ids and task subjects, allows shared reference ids", () => {
  const corpus = extractAll(fixture());
  assert.equal(corpus.forbidden.get("CLM-1001"), "named in a task's input");
  assert.equal(corpus.forbidden.get("B-0501"), "record id seen in a single task");
  assert.equal(corpus.forbidden.get("train_001"), "task label");
  assert.equal(corpus.forbidden.has("POL-12"), false, "a policy seen in two tasks is domain data");
});

test("structure is published at once; policy is a hypothesis the Actor never sees", () => {
  const { fx } = seeded();
  assert.equal(el(fx, "E.Claim").status, "active");
  assert.equal(el(fx, "A.release_payment").status, "candidate");
  assert.equal(el(fx, "A.release_payment").support, 0, "a quote is not support for a rule");
  assert.match(view(fx), /### E\.Claim/);
  assert.ok(!view(fx).includes("A.release_payment"), "hypotheses are not rendered");
  const dest = path.join(fx.root, "skill");
  exportSlot(fx.slot, dest);
  const lean = JSON.parse(fs.readFileSync(path.join(dest, "ontology.json"), "utf8"));
  assert.deepEqual(lean.elements.map((e) => e.id).sort(), ["E.Bill", "E.Claim"]);
  assert.ok(lean.elements.every((e) => e.evidence === undefined));
  assert.deepEqual(fs.readdirSync(dest).sort(), ["ONTOLOGY.md", "SKILL.md", "ontology.json"]);
  const log = fs.readFileSync(path.join(fx.slot, "CHANGELOG.md"), "utf8");
  assert.match(log, /ADD A\.release_payment \(action, hypothesis\)/);
  assert.ok(!log.includes("approved claim and no void"), "the changelog carries no quotes");
});

test("rejections: bad quote, instance id, missing decides, unknown reference, reused id, old ops", () => {
  const { fx, corpus } = seeded();
  const r = applyEdits(
    fx.slot,
    [
      { op: "ADD", element: { ...BILL, id: "E.Payment" }, evidence: [{ session: "s1", quote: "a sentence nobody said" }] },
      {
        op: "ADD",
        element: { id: "C.once", kind: "constraint", decides: ["decision"], rule: "CLM-1001 must not be paid twice" },
        evidence: [q1Policy],
      },
      { op: "ADD", element: { id: "C.twice", kind: "constraint", rule: "a claim is paid at most once" }, evidence: [q1Policy] },
      { op: "ADD", element: { ...PAY, id: "A.hold", requires_evidence: ["E.Ghost"] }, evidence: [q1Policy] },
      { op: "ADD", element: CLAIM, evidence: [q1Claim] },
      { op: "ADD", element: { ...BILL, id: "E.Bx" }, evidence: [{ session: "s1", quote: "short" }] },
      { op: "SUPPORT", id: "A.release_payment", session: "s2", quote: q2Policy.quote },
    ],
    corpus,
    { date: DATE },
  );
  assert.equal(r.published, false);
  const reasons = r.rejected.map((x) => x.reason);
  assert.match(reasons[0], /not found verbatim/);
  assert.match(reasons[1], /instance ids in content: CLM-1001/);
  assert.match(reasons[2], /needs decides/);
  assert.match(reasons[3], /E\.Ghost/);
  assert.match(reasons[4], /exists/);
  assert.match(reasons[5], /shorter/);
  assert.match(reasons[6], /unknown op SUPPORT/);
});

test("the judge is asked once per distinct answer, and a budget stops it", async () => {
  const fx = fixture();
  const before = asked;
  const a = await judgeAnswer(fx.work, CFG, "train_001", BASE.train_001, ask);
  const b = await judgeAnswer(fx.work, CFG, "train_001", { ...BASE.train_001 }, ask);
  assert.equal(a.score, 33.3333);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(asked - before, 1);
  assert.deepEqual(judgeCalls(fx.work), { train_001: 1 });
  await assert.rejects(
    judgeAnswer(fx.work, { ...CFG, budget_per_task: 1 }, "train_001", GOLD.train_001, ask),
    /judge budget for train_001 is spent/,
  );
});

test("localize finds the fields without credit; gaps ranks the ones that recur across tasks", async () => {
  const fx = fixture();
  assert.deepEqual([...leafPaths(BASE.train_001).keys()], ["decision", "hold_reason", "audit.rule", "audit.order"]);
  const l1 = await localize(fx.work, CFG, "train_001", BASE.train_001, ask);
  assert.deepEqual(l1.credited.map((c) => c.path), ["hold_reason"]);
  assert.deepEqual(l1.no_credit, ["decision", "audit.rule", "audit.order"]);
  await localize(fx.work, CFG, "train_002", BASE.train_002, ask);
  const g = gaps(fx.work);
  assert.deepEqual(g.gaps.map((x) => [x.path, x.tasks.length]), [["audit.order", 2], ["audit.rule", 2], ["decision", 1]]);
  assert.equal(g.gaps[2].credited, 1, "decision earns credit in the other task, so it is a scored field");
});

test("lists of records are localized record by record, and a rule about a field covers every record", async () => {
  const fx = fixture();
  const gold = { rows: [{ id: "a", route: "x" }, { id: "b", route: "y" }], tags: ["p", "q"] };
  const askRows = async (_c, _t, answer) => {
    let right = 0;
    (answer.rows || []).forEach((r, i) => {
      if (r.id === gold.rows[i]?.id) right += 1;
      if (r.route === gold.rows[i]?.route) right += 1;
    });
    return { score: right / 4 };
  };
  const answer = { rows: [{ id: "a", route: "x" }, { id: "b", route: "WRONG" }], tags: ["p", "q"] };
  assert.deepEqual([...leafPaths(answer).keys()], ["rows[0].id", "rows[0].route", "rows[1].id", "rows[1].route", "tags"]);
  const l = await localize(fx.work, CFG, "t", answer, askRows);
  assert.equal(l.score, 75);
  assert.deepEqual(l.credited.map((c) => c.path), ["rows[0].id", "rows[0].route", "rows[1].id"]);
  assert.deepEqual(l.no_credit, ["rows[1].route", "tags"]);
  // A true/false field without credit is flipped: wrong if the score rises, unscored if nothing moves.
  const askFlags = async (_c, _t, a) => ({ score: (a.urgent === true ? 0.5 : 0) + (a.name === "n" ? 0.5 : 0) });
  const lf = await localize(fx.work, CFG, "flags", { urgent: false, internal: true, name: "n" }, askFlags);
  assert.deepEqual(lf.wrong, [{ path: "urgent", delta: 50 }]);
  assert.deepEqual(lf.unscored, ["internal"]);
  assert.deepEqual(gaps(fx.work).gaps.find((x) => x.path === "urgent").wrong, 1);
  assert.equal(gaps(fx.work).gaps.some((x) => x.path === "internal"), false, "unscored fields are not gaps");
  const fixed = { ...answer, rows: [answer.rows[0], { id: "b", route: "y" }] };
  assert.deepEqual(changedPaths(answer, fixed), ["rows[1].route"]);
  // decides: ["rows.route"] covers rows[1].route; an experiment that also touched rows[1].id would be refused.
  initSlot(fx.slot, { date: DATE });
  const corpus = extractAll(fx);
  const rule = { id: "C.route", kind: "constraint", decides: ["rows.route"], rule: "route follows the record's plan" };
  assert.equal(applyEdits(fx.slot, [{ op: "ADD", element: rule, evidence: [q1Policy] }], corpus, { date: DATE }).published, true);
  const r = await runExperiment(fx.slot, fx.work, CFG, { task: "t", base: answer, variant: fixed, tests: ["C.route"], predict: "better" }, { ask: askRows, date: DATE });
  assert.equal(r.outcome, "confirmed");
  await assert.rejects(
    runExperiment(fx.slot, fx.work, CFG, { task: "t", base: answer, variant: { ...fixed, rows: [fixed.rows[0], { id: "c", route: "y" }] }, tests: ["C.route"], predict: "better" }, { ask: askRows, date: DATE }),
    /also changes rows\[1\]\.id/,
  );
});

test("an experiment that moves as predicted makes a hypothesis active", async () => {
  const { fx, corpus } = seeded();
  const variant = { ...BASE.train_001, decision: "deny" };
  assert.deepEqual(changedPaths(BASE.train_001, variant), ["decision"]);
  const r = await exp(fx, { task: "train_001", base: BASE.train_001, variant, tests: ["A.release_payment"], predict: "better" });
  assert.equal(r.outcome, "confirmed");
  assert.equal(r.delta, 33.3334);
  assert.equal(r.published, true);
  assert.equal(el(fx, "A.release_payment").status, "active");
  assert.equal(el(fx, "A.release_payment").support, 0, "an experiment shows the value, not the rule");
  assert.match(view(fx), /### A\.release_payment · tested in 1 task, not yet reproduced\nDecides: decision/);
  // The other direction: the base follows the rule, the variant breaks it.
  const r2 = await exp(fx, {
    task: "train_002",
    base: BASE.train_002,
    variant: { ...BASE.train_002, decision: "pay" },
    tests: ["A.release_payment"],
    predict: "worse",
  });
  assert.equal(r2.outcome, "confirmed");
  assert.match(view(fx), /tested in 2 tasks, not yet reproduced/);
  const v = validateSlot(fx.slot, corpus, fx.work);
  assert.equal(v.ok, true, v.errors.join("; "));
});

test("a refuted hypothesis is retired before it reaches the Actor", async () => {
  const { fx } = seeded();
  // The rule would turn a right answer wrong.
  const r = await exp(fx, {
    task: "train_002",
    base: BASE.train_002,
    variant: { ...BASE.train_002, decision: "pay" },
    tests: ["A.release_payment"],
    predict: "better",
  });
  assert.equal(r.outcome, "refuted");
  assert.equal(el(fx, "A.release_payment").status, "retired");
  assert.equal(el(fx, "A.release_payment").retired_reason, "refuted by exp:1");
  assert.ok(!view(fx).includes("A.release_payment"));
  await assert.rejects(
    exp(fx, { task: "train_001", base: BASE.train_001, variant: GOLD.train_001, tests: ["A.release_payment"], predict: "better" }),
    /not a live element/,
  );
  assert.deepEqual(summarize(fx.slot, fx.work).refuted_before_deployment, ["A.release_payment"]);
});

test("experiments: stray fields are refused, no movement is inconclusive, a jointly scored section needs the whole variant", async () => {
  const { fx } = seeded();
  await assert.rejects(
    exp(fx, {
      task: "train_001",
      base: BASE.train_001,
      variant: { ...BASE.train_001, decision: "deny", hold_reason: "x" },
      tests: ["A.release_payment"],
      predict: "better",
    }),
    /also changes hold_reason/,
  );
  await assert.rejects(
    exp(fx, { task: "train_001", base: BASE.train_001, variant: BASE.train_001, tests: ["A.release_payment"], predict: "better" }),
    /same answer/,
  );
  await assert.rejects(
    exp(fx, { task: "train_001", base: BASE.train_001, variant: GOLD.train_001, tests: ["E.Claim"], predict: "better" }),
    /experiments test policy/,
  );
  // Half of the audit section right: the judge scores it as a whole, so nothing moves.
  const half = { ...BASE.train_001, audit: { rule: "policy_first", order: ["bill", "claim"] } };
  const r1 = await exp(fx, { task: "train_001", base: BASE.train_001, variant: half, tests: ["P.policy_first"], predict: "better" });
  assert.equal(r1.outcome, "inconclusive");
  assert.equal(r1.published, false);
  assert.equal(el(fx, "P.policy_first").status, "candidate");
  const whole = { ...BASE.train_001, audit: GOLD.train_001.audit };
  const r2 = await exp(fx, { task: "train_001", base: BASE.train_001, variant: whole, tests: ["P.policy_first"], predict: "better" });
  assert.equal(r2.outcome, "confirmed");
  // Without --tests it only compares.
  const r3 = await exp(fx, { task: "train_001", base: BASE.train_001, variant: GOLD.train_001 });
  assert.equal(r3.outcome, "compared");
  assert.equal(r3.delta, 66.6667);
  assert.equal(r3.published, false);
});

test("a bundle is confirmed together; a refuted bundle retires nobody", async () => {
  const { fx } = seeded();
  const both = { ...BASE.train_001, decision: "deny", audit: GOLD.train_001.audit };
  const r = await exp(fx, { task: "train_001", base: BASE.train_001, variant: both, tests: ["A.release_payment", "P.policy_first"], predict: "better" });
  assert.equal(r.outcome, "confirmed");
  assert.equal(el(fx, "A.release_payment").status, "active");
  assert.equal(el(fx, "P.policy_first").status, "active");
  const r2 = await exp(fx, { task: "train_001", base: both, variant: BASE.train_001, tests: ["A.release_payment", "P.policy_first"], predict: "better" });
  assert.equal(r2.outcome, "refuted");
  assert.equal(r2.published, false);
  assert.equal(el(fx, "P.policy_first").status, "active");
});

test("changing a confirmed rule sends it back to hypothesis; rewording its description does not", async () => {
  const { fx, corpus } = seeded();
  await exp(fx, { task: "train_001", base: BASE.train_001, variant: { ...BASE.train_001, decision: "deny" }, tests: ["A.release_payment"], predict: "better" });
  const r1 = applyEdits(fx.slot, [{ op: "REFINE", id: "A.release_payment", set: { description: "Check the bills before deciding." } }], corpus, { date: DATE });
  assert.equal(r1.published, true, JSON.stringify(r1.rejected));
  assert.equal(el(fx, "A.release_payment").status, "active");
  const r2 = applyEdits(fx.slot, [{ op: "REFINE", id: "A.release_payment", set: { preconditions: ["claim.status == approved"] } }], corpus, { date: DATE });
  assert.match(r2.applied[0].summary, /back to hypothesis/);
  assert.equal(el(fx, "A.release_payment").status, "candidate");
  assert.equal(el(fx, "A.release_payment").support, 0);
  // Structure still needs a quote to change.
  const r3 = applyEdits(fx.slot, [{ op: "REFINE", id: "E.Claim", set: { key: "id" } }], corpus, { date: DATE });
  assert.match(r3.rejected[0].reason, /needs at least one quote/);
});

test("retire refuses a referenced element; merge is for structure and rewrites references", () => {
  const { fx, corpus } = seeded();
  const r1 = applyEdits(fx.slot, [{ op: "RETIRE", id: "E.Claim", reason: "wrong" }], corpus, { date: DATE });
  assert.match(r1.rejected[0].reason, /referenced by A\.release_payment/);
  const r2 = applyEdits(
    fx.slot,
    [
      { op: "ADD", element: { ...BILL, id: "E.Invoice", name: "Invoice" }, evidence: [q1Bill] },
      { op: "REFINE", id: "A.release_payment", set: { requires_evidence: ["E.Invoice"], preconditions: ["no linked E.Invoice has state void"] } },
      { op: "MERGE", id: "E.Bill", from: ["E.Invoice"] },
      { op: "MERGE", id: "A.release_payment", from: ["P.policy_first"] },
    ],
    corpus,
    { date: DATE },
  );
  assert.equal(r2.published, true);
  assert.match(r2.rejected[0].reason, /MERGE is for structure/);
  assert.deepEqual(el(fx, "A.release_payment").requires_evidence, ["E.Bill"]);
  assert.deepEqual(el(fx, "A.release_payment").preconditions, ["no linked E.Bill has state void"]);
  assert.equal(el(fx, "E.Invoice").merged_into, "E.Bill");
  const r3 = applyEdits(fx.slot, [{ op: "ADD", element: { ...BILL, id: "E.Invoice" }, evidence: [q1Bill] }], corpus, { date: DATE });
  assert.match(r3.rejected[0].reason, /never reused/);
});

test("over budget: nothing is published, by edit or by experiment", async () => {
  const { fx, corpus } = seeded();
  const file = path.join(fx.slot, "ontology.json");
  const onto = JSON.parse(fs.readFileSync(file, "utf8"));
  onto.budget_tokens = Math.ceil(view(fx).length / 4) + 5;
  fs.writeFileSync(file, JSON.stringify(onto, null, 2));
  const before = fs.readFileSync(file, "utf8");
  const r = applyEdits(fx.slot, [{ op: "ADD", element: { ...BILL, id: "E.Payment", name: "Payment" }, evidence: [q1Bill] }], corpus, { date: DATE });
  assert.equal(r.published, false);
  assert.match(r.reason, /over the budget/);
  const x = await exp(fx, { task: "train_001", base: BASE.train_001, variant: { ...BASE.train_001, decision: "deny" }, tests: ["A.release_payment"], predict: "better" });
  assert.equal(x.outcome, "confirmed");
  assert.equal(x.published, false);
  assert.match(x.reason, /recorded/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("validate catches hand edits", async () => {
  const { fx, corpus } = seeded();
  assert.equal(validateSlot(fx.slot, corpus, fx.work).ok, true);
  fs.appendFileSync(path.join(fx.slot, "ONTOLOGY.md"), "\nAlways approve.\n");
  const skill = path.join(fx.slot, "SKILL.md");
  fs.writeFileSync(skill, fs.readFileSync(skill, "utf8").replace("Keep this folder unchanged", "Feel free to edit"));
  const file = path.join(fx.slot, "ontology.json");
  const onto = JSON.parse(fs.readFileSync(file, "utf8"));
  onto.elements.find((e) => e.id === "A.release_payment").status = "active";
  const p = onto.elements.find((e) => e.id === "P.policy_first");
  p.status = "active";
  p.support = 1;
  p.evidence.push({ type: "experiment", id: "exp:9", task: "train_001" });
  onto.elements.find((e) => e.id === "E.Bill").evidence[0].quote = "invented evidence text";
  fs.writeFileSync(file, JSON.stringify(onto));
  const all = validateSlot(fx.slot, corpus, fx.work).errors.join("\n");
  assert.match(all, /ONTOLOGY\.md differs/);
  assert.match(all, /SKILL\.md body differs/);
  assert.match(all, /A\.release_payment: active policy without a confirming experiment/);
  assert.match(all, /P\.policy_first: exp:9 is not in experiments\.jsonl/);
  assert.match(all, /E\.Bill: quote not found verbatim/);
});

// Records an Actor attempt the way `onto.mjs judge --phase` does.
async function attempt(fx, phase, task, answer) {
  const r = await judgeAnswer(fx.work, CFG, task, answer, ask);
  fs.appendFileSync(
    path.join(fx.work, "records.jsonl"),
    `${JSON.stringify({ kind: "attempt", phase, task, answer_sha: r.answer_sha, score: r.score })}\n`,
  );
}

test("replication: a rule an Actor reproduced is marked, a harmful one is retired, a silent one is demoted", async () => {
  const { fx, corpus } = seeded();
  const HOLD = { id: "C.hold_reason", kind: "constraint", decides: ["hold_reason"], rule: "hold_reason names the blocking record type" };
  assert.equal(applyEdits(fx.slot, [{ op: "ADD", element: HOLD, evidence: [q1Policy] }], corpus, { date: DATE }).published, true);
  // All three pass their experiments.
  await exp(fx, { task: "train_001", base: BASE.train_001, variant: { ...BASE.train_001, decision: "deny" }, tests: ["A.release_payment"], predict: "better" });
  await exp(fx, { task: "train_001", base: BASE.train_001, variant: { ...BASE.train_001, audit: GOLD.train_001.audit }, tests: ["P.policy_first"], predict: "better" });
  await exp(fx, { task: "train_001", base: BASE.train_001, variant: { ...BASE.train_001, hold_reason: "x" }, tests: ["C.hold_reason"], predict: "worse" });
  for (const t of ["train_001", "train_002"]) await attempt(fx, "baseline", t, BASE[t]);
  // The Actors that read the ontology: the decision is fixed in task 1, the audit trail is
  // still wrong everywhere, and the hold reason, right before, is now wrong in task 2.
  await attempt(fx, "verify", "train_001", { ...BASE.train_001, decision: "deny" });
  await attempt(fx, "verify", "train_002", { ...BASE.train_002, hold_reason: "bill" });
  const r = await replicate(fx.slot, fx.work, CFG, { ask, date: DATE });
  const result = Object.fromEntries(r.elements.map((e) => [e.id, e.result]));
  assert.deepEqual(result, { "A.release_payment": "reproduced", "P.policy_first": "not reproduced", "C.hold_reason": "harm" });
  assert.equal(el(fx, "A.release_payment").support, 1);
  assert.match(view(fx), /### A\.release_payment · reproduced in 1 task/);
  assert.equal(el(fx, "P.policy_first").status, "candidate");
  assert.equal(el(fx, "C.hold_reason").status, "retired");
  assert.match(el(fx, "C.hold_reason").retired_reason, /lost credit on hold_reason in train_002/);
  assert.ok(!view(fx).includes("P.policy_first") && !view(fx).includes("C.hold_reason"));
  const v = validateSlot(fx.slot, corpus, fx.work);
  assert.equal(v.ok, true, v.errors.join("; "));
  // finish: export, final answers from the verify attempts, summary.
  const out = finish(fx.slot, fx.work, fx.corpusDir, path.join(fx.root, "skill"), path.join(fx.root, "answers"));
  assert.equal(out.ok, true);
  assert.deepEqual(out.answers, { train_001: "verify", train_002: "verify" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.root, "answers", "train_001.json"), "utf8")).decision, "deny");
  assert.equal(out.summary.replication["A.release_payment"], "reproduced");
  assert.deepEqual(out.summary.phase_means, { baseline: 50, verify: 50 });
});

test("replication: a rule whose fields already had credit is kept, with no gain shown", async () => {
  const { fx } = seeded();
  await exp(fx, { task: "train_002", base: BASE.train_002, variant: { ...BASE.train_002, decision: "pay" }, tests: ["A.release_payment"], predict: "worse" });
  await attempt(fx, "baseline", "train_002", BASE.train_002);
  await attempt(fx, "verify", "train_002", { ...BASE.train_002 });
  const r = await replicate(fx.slot, fx.work, CFG, { ask, date: DATE });
  assert.equal(r.elements[0].result, "held");
  assert.equal(r.published, false);
  assert.equal(el(fx, "A.release_payment").status, "active");
  assert.match(view(fx), /tested in 1 task, not yet reproduced/);
});

test("replication: a rule never paired with a verify attempt leaves the view; measurement ignores the budget", async () => {
  const { fx } = seeded();
  await exp(fx, { task: "train_001", base: BASE.train_001, variant: { ...BASE.train_001, decision: "deny" }, tests: ["A.release_payment"], predict: "better" });
  await exp(fx, { task: "train_002", base: BASE.train_002, variant: { ...BASE.train_002, audit: GOLD.train_002.audit }, tests: ["P.policy_first"], predict: "better" });
  // Only train_001 gets a verify attempt: P.policy_first, tested in train_002 alone, was never replicated.
  for (const t of ["train_001", "train_002"]) await attempt(fx, "baseline", t, BASE[t]);
  await attempt(fx, "verify", "train_001", { ...BASE.train_001, decision: "deny" });
  const before = asked;
  const r = await replicate(fx.slot, fx.work, { ...CFG, budget_per_task: 1 }, { ask, date: DATE });
  const result = Object.fromEntries(r.elements.map((e) => [e.id, e.result]));
  assert.deepEqual(result, { "A.release_payment": "reproduced", "P.policy_first": "not replicated" });
  assert.equal(el(fx, "P.policy_first").status, "candidate");
  assert.ok(!view(fx).includes("P.policy_first"));
  // Only decided fields are knocked out: decision and the two audit fields, in two answers.
  assert.ok(asked - before <= 6, `replication asked the judge ${asked - before} times`);
});

test("export owns its folder: files written beside it are removed", () => {
  const { fx } = seeded();
  const dest = path.join(fx.root, "skill");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "PLAYBOOK.md"), "unchecked recipes");
  fs.writeFileSync(path.join(dest, ".keep"), "");
  const r = exportSlot(fx.slot, dest);
  assert.deepEqual(r.removed, ["PLAYBOOK.md"]);
  assert.deepEqual(fs.readdirSync(dest).sort(), [".keep", "ONTOLOGY.md", "SKILL.md", "ontology.json"]);
  fs.mkdirSync(path.join(dest, "extra"));
  assert.throws(() => exportSlot(fx.slot, dest), /refusing to export there/);
});

test("diff and skill versions", async () => {
  const { fx } = seeded();
  const before = JSON.parse(fs.readFileSync(path.join(fx.slot, "ontology.json"), "utf8"));
  await exp(fx, { task: "train_001", base: BASE.train_001, variant: { ...BASE.train_001, decision: "deny" }, tests: ["A.release_payment"], predict: "better" });
  const after = JSON.parse(fs.readFileSync(path.join(fx.slot, "ontology.json"), "utf8"));
  assert.deepEqual(diffOntologies(before, after).promoted, ["A.release_payment"]);
  assert.equal(nextSkillVersion("2026.11.12.3", "2026-11-12"), "2026.11.12.4");
  assert.equal(nextSkillVersion("2026.11.11.3", "2026-11-12"), "2026.11.12.1");
});

test("CLI end to end against an HTTP judge", async () => {
  const fx = fixture();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const { task_id, answer } = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(await ask(null, task_id, answer)));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const cfg = path.join(fx.root, "training-request.json");
    fs.writeFileSync(cfg, JSON.stringify({ judge: { url: `http://127.0.0.1:${server.address().port}/api/judge`, budget_per_task: 30 } }));
    const cli = async (...args) => {
      try {
        const { stdout } = await run(process.execPath, [SCRIPT, ...args]);
        return { code: 0, out: JSON.parse(stdout) };
      } catch (e) {
        return { code: e.code, err: e.stderr };
      }
    };
    const file = (name, v) => {
      const f = path.join(fx.root, name);
      fs.writeFileSync(f, JSON.stringify(v));
      return f;
    };
    assert.equal((await cli("init", fx.slot, "--date", DATE)).code, 0);
    for (const [s, t] of [["s1", "train_001"], ["s2", "train_002"]]) {
      const x = await cli("extract", "--session", s, "--agent-dir", fx.agentDir, "--task", t, "--out", fx.corpusDir, "--log", path.join(fx.root, `${s}.log`));
      assert.equal(x.code, 0, x.err);
    }
    const base = file("base.json", BASE.train_001);
    const common = ["--config", cfg, "--work", fx.work];
    const jr = await cli("judge", "--task", "train_001", "--answer", base, "--phase", "baseline", "--session", "s1", ...common);
    assert.equal(jr.out.score, 33.3333);
    const lr = await cli("localize", "--task", "train_001", "--answer", base, ...common);
    assert.deepEqual(lr.out.no_credit, ["decision", "audit.rule", "audit.order"]);
    assert.equal((await cli("gaps", "--work", fx.work)).out.gaps.length, 3);
    const edits = file("edits.json", { operations: [
      { op: "ADD", element: CLAIM, evidence: [q1Claim] },
      { op: "ADD", element: BILL, evidence: [q1Bill] },
      { op: "ADD", element: PAY, evidence: [q1Policy] },
    ] });
    const ar = await cli("apply", fx.slot, edits, "--corpus", fx.corpusDir, "--work", fx.work, "--date", DATE);
    assert.equal(ar.out.published, true, JSON.stringify(ar.out));
    const variant = file("variant.json", { ...BASE.train_001, decision: "deny" });
    const er = await cli("experiment", fx.slot, "--task", "train_001", "--base", base, "--variant", variant, "--tests", "A.release_payment", "--predict", "better", "--snapshots", path.join(fx.work, "snapshots"), "--date", DATE, ...common);
    assert.equal(er.out.outcome, "confirmed", er.err);
    assert.ok(fs.existsSync(path.join(fx.work, "snapshots", "v2.json")));
    await cli("judge", "--task", "train_001", "--answer", variant, "--phase", "verify", ...common);
    assert.equal((await cli("validate", fx.slot, "--corpus", fx.corpusDir, "--work", fx.work)).code, 0);
    const sr = await cli("summary", fx.slot, "--work", fx.work);
    assert.deepEqual(sr.out.phase_means, { baseline: 33.33, verify: 66.67 });
    assert.equal(sr.out.experiments.confirmed, 1);
    assert.equal(sr.out.judge_calls.train_001, 6);
    const kinds = fs.readFileSync(path.join(fx.work, "records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
    assert.deepEqual(kinds, ["attempt", "localize", "apply", "experiment", "attempt"]);
    fs.appendFileSync(path.join(fx.slot, "ONTOLOGY.md"), "tampered\n");
    assert.equal((await cli("validate", fx.slot, "--corpus", fx.corpusDir, "--work", fx.work)).code, 1);
    assert.equal((await cli("bogus")).code, 2);
    // An attempt is baseline or verify, nothing else.
    const bad = await cli("judge", "--task", "train_001", "--answer", variant, "--phase", "rejected", ...common);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--phase must be baseline or verify/);
    // One run, one work directory.
    const pinned = path.join(fx.root, "pinned.json");
    fs.writeFileSync(pinned, JSON.stringify({ judge: { url: "http://127.0.0.1:1/" }, paths: { work: fx.work } }));
    const stray = await cli("judge", "--task", "train_001", "--answer", variant, "--config", pinned, "--work", path.join(fx.work, "work"));
    assert.equal(stray.code, 2);
    assert.match(stray.err, /is not the run's work directory/);
  } finally {
    server.close();
  }
});
