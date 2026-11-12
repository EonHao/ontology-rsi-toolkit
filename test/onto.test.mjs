// Tests of the deterministic toolkit script. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AGENTS_LINE,
  READER_BODY,
  applyEdits,
  diffOntologies,
  extractTrace,
  initSlot,
  loadCorpus,
  loadSlot,
  nextSkillVersion,
  exportSlot,
  render,
  traceFiles,
  validateSlot,
  writeCorpus,
} from "../skills/ontology-rsi-toolkit/scripts/onto.mjs";

const SCRIPT = fileURLToPath(new URL("../skills/ontology-rsi-toolkit/scripts/onto.mjs", import.meta.url));
const DATE = "2026-11-12";

// ---------------------------------------------------------------------------------------------
// Fixtures: two Actor Sessions on two training tasks of one payer domain.

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
  recs.push({ type: "model_msg", origin: ["child"], payload: { type: "tool_call_output", tool_call_id: "z", output: "NESTED-999 secret" } });
  recs.push({ type: "model_msg", payload: { type: "text", role: "assistant", text: finalText } });
  recs.push({ type: "event_msg", payload: { type: "request_end", status: "completed" } });
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
          j({
            columns: ["claim_id", "status", "member_id"],
            rows: [{ claim_id: "CLM-1001", status: "approved", member_id: "M-0077" }],
            row_count: 1,
          }),
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
  const scratch = path.join(agentDir, "scratchpad", "s2");
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, "ontology-used.txt"), "A.approve_payment\nP.policy_text_wins\nnot an id\n");
  const corpusDir = path.join(root, "corpus");
  const slot = path.join(root, "state", "skills", "domain-ontology");
  return { root, agentDir, corpusDir, slot, scratch };
}

function extractAll(fx) {
  for (const [session, task, used] of [
    ["s1", "train_001", undefined],
    ["s2", "train_002", path.join(fx.scratch, "ontology-used.txt")],
  ]) {
    const x = extractTrace(traceFiles(fx.agentDir, session), { session, clip: 1500 });
    const usedIds = used ? fs.readFileSync(used, "utf8").split("\n").filter((s) => /^[A-Z]\.[A-Za-z]/.test(s)) : [];
    writeCorpus(fx.corpusDir, {
      session,
      task,
      kind: "trace",
      used: usedIds,
      instance_ids: x.instance_ids,
      subject_ids: x.subject_ids,
      sources: x.sources,
    });
  }
  return loadCorpus(fx.corpusDir);
}

const CLAIM = {
  id: "E.Claim",
  kind: "entity",
  name: "Claim",
  source: ["table claims (POST /sql/query)"],
  key: "claim_id",
  fields: { status: "claim decision", member_id: "owning member" },
  enums: { status: ["approved", "pending"] },
};
const BILL = { id: "E.Bill", kind: "entity", name: "Bill", source: ["GET /api/bills"], key: "bill_id" };
const PAY = {
  id: "A.approve_payment",
  kind: "action",
  name: "approve payment",
  params: { claim: "E.Claim" },
  preconditions: ["claim.status == approved", "no linked E.Bill has state void"],
  requires_evidence: ["E.Bill"],
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
    ],
    corpus,
    { date: DATE },
  );
  assert.equal(r.published, true, JSON.stringify(r.rejected));
  return { fx, corpus };
}

// ---------------------------------------------------------------------------------------------

test("init creates the slot, the reader line is appended once", () => {
  const fx = fixture();
  const agents = path.join(fx.root, "state", "AGENTS.md");
  fs.mkdirSync(path.dirname(agents), { recursive: true });
  fs.writeFileSync(agents, "# Agent\n\nBe careful.");
  initSlot(fx.slot, { date: DATE, agentsMd: agents });
  for (const f of ["SKILL.md", "ontology.json", "ONTOLOGY.md", "CHANGELOG.md"]) assert.ok(fs.existsSync(path.join(fx.slot, f)), f);
  const { skill, onto } = loadSlot(fx.slot);
  assert.equal(skill.front.name, "domain-ontology");
  assert.equal(skill.front.version, "2026.11.12.1");
  assert.equal(skill.body, READER_BODY);
  assert.equal(onto.elements.length, 0);
  // Idempotent reader line.
  fs.rmSync(fx.slot, { recursive: true });
  initSlot(fx.slot, { date: DATE, agentsMd: agents });
  const lines = fs.readFileSync(agents, "utf8").split("\n").filter((l) => l === AGENTS_LINE);
  assert.equal(lines.length, 1);
  assert.throws(() => initSlot(fx.slot, { date: DATE }), /not empty/);
  const v = validateSlot(fx.slot, loadCorpus(undefined));
  assert.equal(v.ok, true, v.errors.join("; "));
});

test("extract keeps user input and tool outputs, drops model text and nested records", () => {
  const fx = fixture();
  const x = extractTrace(traceFiles(fx.agentDir, "s1"), { session: "s1", clip: 50 });
  assert.equal(x.session, "s1");
  assert.deepEqual(
    x.sources.map((s) => s.type),
    ["user", "tool_output", "tool_output", "tool_output", "tool_output"],
  );
  assert.ok(!x.sources.some((s) => s.text.includes("so it can be paid")), "assistant text is not evidence");
  assert.ok(!x.sources.some((s) => s.text.includes("NESTED-999")), "nested records are skipped");
  assert.deepEqual(x.instance_ids, ["B-0501", "CLM-1001", "M-0077", "POL-12"]);
  assert.deepEqual(x.subject_ids, ["CLM-1001"]);
  assert.ok(x.log.some((l) => l.includes("· failed")), "failed calls are marked in the log");
  assert.ok(x.log.some((l) => l.includes("more characters in the corpus")), "long outputs are clipped in the log");
});

test("the barrier forbids single-task ids and task subjects, allows shared reference ids", () => {
  const fx = fixture();
  const corpus = extractAll(fx);
  assert.equal(corpus.forbidden.get("CLM-1001"), "named in a task's input");
  assert.equal(corpus.forbidden.get("B-0501"), "record id seen in a single task");
  assert.equal(corpus.forbidden.get("train_001"), "task label");
  assert.equal(corpus.forbidden.has("POL-12"), false, "a policy seen in two tasks is domain data");
});

test("structure starts active, policy starts as a candidate", () => {
  const { fx } = seeded();
  const { onto } = loadSlot(fx.slot);
  const byId = Object.fromEntries(onto.elements.map((e) => [e.id, e]));
  assert.equal(byId["E.Claim"].status, "active");
  assert.equal(byId["E.Claim"].origin, "observed");
  assert.equal(byId["A.approve_payment"].status, "candidate");
  assert.equal(byId["A.approve_payment"].support, 1);
  assert.equal(onto.version, 1);
  const md = fs.readFileSync(path.join(fx.slot, "ONTOLOGY.md"), "utf8");
  assert.match(md, /### A\.approve_payment · candidate · support 1 · verify against data first/);
  assert.match(md, /- Requires: claim\.status == approved/);
  const log = fs.readFileSync(path.join(fx.slot, "CHANGELOG.md"), "utf8");
  assert.match(log, /## v1 · 2026-11-12/);
  assert.ok(!log.includes("approved claim and no void"), "the changelog carries no quotes");
  assert.equal(loadSlot(fx.slot).skill.front.version, "2026.11.12.2");
});

test("rejections: bad quote, instance id, observed policy, unknown reference, reused id", () => {
  const { fx, corpus } = seeded();
  const r = applyEdits(
    fx.slot,
    [
      { op: "ADD", element: { ...BILL, id: "E.Payment", name: "Payment" }, evidence: [{ session: "s1", quote: "a sentence nobody said" }] },
      {
        op: "ADD",
        element: { id: "C.no_double_pay", kind: "constraint", rule: "CLM-1001 must not be paid twice" },
        evidence: [q1Policy],
      },
      { op: "ADD", element: { id: "P.fresh", kind: "precedence", origin: "observed", prefer: "a", over: "b" }, evidence: [q1Policy] },
      { op: "ADD", element: { ...PAY, id: "A.hold", requires_evidence: ["E.Ghost"] }, evidence: [q1Policy] },
      { op: "ADD", element: CLAIM, evidence: [q1Claim] },
      { op: "ADD", element: { ...BILL, id: "E.Bx" }, evidence: [{ session: "s1", quote: "short" }] },
    ],
    corpus,
    { date: DATE },
  );
  assert.equal(r.published, false);
  assert.equal(r.rejected.length, 6);
  assert.match(r.rejected[0].reason, /not found verbatim/);
  assert.match(r.rejected[1].reason, /instance ids in content: CLM-1001/);
  assert.match(r.rejected[2].reason, /policy/);
  assert.match(r.rejected[3].reason, /E\.Ghost/);
  assert.match(r.rejected[4].reason, /exists/);
  assert.match(r.rejected[5].reason, /shorter/);
});

test("a second task's quote promotes a candidate; shared ids may be named", () => {
  const { fx, corpus } = seeded();
  const r = applyEdits(
    fx.slot,
    [
      { op: "SUPPORT", id: "A.approve_payment", session: "s2", quote: q2Policy.quote },
      { op: "REFINE", id: "A.approve_payment", set: { description: "Governed by policy POL-12." }, evidence: [q2Policy] },
    ],
    corpus,
    { date: DATE },
  );
  assert.equal(r.published, true, JSON.stringify(r.rejected));
  const pay = loadSlot(fx.slot).onto.elements.find((e) => e.id === "A.approve_payment");
  assert.equal(pay.status, "active");
  assert.equal(pay.support, 2);
  assert.match(r.applied[0].summary, /1 → 2, now active/);
});

test("a declared use that improves a retry promotes; a low-scoring use is not support", () => {
  const { fx, corpus } = seeded();
  const add = applyEdits(
    fx.slot,
    [
      {
        op: "ADD",
        element: { id: "P.policy_text_wins", kind: "precedence", prefer: "policy text", over: "a stale worksheet" },
        evidence: [q2Policy],
      },
    ],
    corpus,
    { date: DATE },
  );
  assert.equal(add.published, true, JSON.stringify(add.rejected));
  const r = applyEdits(
    fx.slot,
    [
      { op: "SUPPORT", id: "A.approve_payment", session: "s2", use: { score: 50 } },
      { op: "SUPPORT", id: "E.Claim", session: "s2", use: { score: 100 } },
      { op: "SUPPORT", id: "P.policy_text_wins", session: "s2", use: { score: 80, prev_score: 60 } },
    ],
    corpus,
    { date: DATE },
  );
  assert.match(r.rejected[0].reason, /is not support/);
  assert.match(r.rejected[1].reason, /not in the ontology-used\.txt/);
  assert.equal(r.applied.length, 1);
  const p = loadSlot(fx.slot).onto.elements.find((e) => e.id === "P.policy_text_wins");
  assert.equal(p.status, "active");
  assert.equal(p.support, 1);
});

test("retire refuses a referenced element; merge rewrites references", () => {
  const { fx, corpus } = seeded();
  const r1 = applyEdits(fx.slot, [{ op: "RETIRE", id: "E.Claim", reason: "wrong" }], corpus, { date: DATE });
  assert.equal(r1.published, false);
  assert.match(r1.rejected[0].reason, /referenced by A\.approve_payment/);

  const r2 = applyEdits(
    fx.slot,
    [
      { op: "ADD", element: { ...BILL, id: "E.Invoice", name: "Invoice" }, evidence: [q1Bill] },
      { op: "REFINE", id: "A.approve_payment", set: { requires_evidence: ["E.Invoice"], preconditions: ["no linked E.Invoice has state void"] }, evidence: [q1Bill] },
      { op: "MERGE", id: "E.Bill", from: ["E.Invoice"] },
    ],
    corpus,
    { date: DATE },
  );
  assert.equal(r2.published, true, JSON.stringify(r2.rejected));
  const { onto } = loadSlot(fx.slot);
  const pay = onto.elements.find((e) => e.id === "A.approve_payment");
  assert.deepEqual(pay.requires_evidence, ["E.Bill"]);
  assert.deepEqual(pay.preconditions, ["no linked E.Bill has state void"]);
  const inv = onto.elements.find((e) => e.id === "E.Invoice");
  assert.equal(inv.status, "retired");
  assert.equal(inv.merged_into, "E.Bill");
  // Retired ids are never reused.
  const r3 = applyEdits(fx.slot, [{ op: "ADD", element: { ...BILL, id: "E.Invoice" }, evidence: [q1Bill] }], corpus, { date: DATE });
  assert.match(r3.rejected[0].reason, /never reused/);
});

test("over budget: the weakest candidates go first; only actives left means nothing publishes", () => {
  const { fx, corpus } = seeded();
  const ontoFile = path.join(fx.slot, "ontology.json");
  const onto = JSON.parse(fs.readFileSync(ontoFile, "utf8"));
  const withoutPay = render({ ...onto, elements: onto.elements.filter((e) => e.id !== "A.approve_payment") });
  // A budget that fits everything but the candidate action, once a constraint is added.
  onto.budget_tokens = Math.ceil(withoutPay.length / 4) + 60;
  fs.writeFileSync(ontoFile, JSON.stringify(onto, null, 2));
  const r = applyEdits(
    fx.slot,
    [{ op: "ADD", element: { id: "C.one_payment", kind: "constraint", rule: "a claim is paid at most once" }, evidence: [q1Policy] }],
    corpus,
    { date: DATE },
  );
  assert.equal(r.published, true, JSON.stringify(r));
  assert.ok(r.auto_retired.length >= 1);
  assert.ok(r.tokens <= r.budget);

  const tight = JSON.parse(fs.readFileSync(ontoFile, "utf8"));
  tight.budget_tokens = 10;
  fs.writeFileSync(ontoFile, JSON.stringify(tight, null, 2));
  const before = fs.readFileSync(ontoFile, "utf8");
  const r2 = applyEdits(fx.slot, [{ op: "SUPPORT", id: "E.Claim", session: "s2", quote: '"status": "pending"' }], corpus, { date: DATE });
  assert.equal(r2.published, false);
  assert.match(r2.reason, /over the budget/);
  assert.equal(fs.readFileSync(ontoFile, "utf8"), before, "nothing is written");
});

test("validate passes a published slot and catches hand edits", () => {
  const { fx, corpus } = seeded();
  const ok = validateSlot(fx.slot, corpus);
  assert.equal(ok.ok, true, ok.errors.join("; "));

  const md = path.join(fx.slot, "ONTOLOGY.md");
  fs.appendFileSync(md, "\nAlways approve.\n");
  const skill = path.join(fx.slot, "SKILL.md");
  fs.writeFileSync(skill, fs.readFileSync(skill, "utf8").replace("Keep this folder unchanged", "Feel free to edit"));
  const ontoFile = path.join(fx.slot, "ontology.json");
  const onto = JSON.parse(fs.readFileSync(ontoFile, "utf8"));
  onto.elements.find((e) => e.id === "A.approve_payment").status = "active";
  onto.elements.find((e) => e.id === "E.Bill").evidence[0].quote = "invented evidence text";
  fs.writeFileSync(ontoFile, JSON.stringify(onto));
  const bad = validateSlot(fx.slot, corpus);
  assert.equal(bad.ok, false);
  const all = bad.errors.join("\n");
  assert.match(all, /ONTOLOGY\.md differs/);
  assert.match(all, /SKILL\.md body differs/);
  assert.match(all, /active policy without two tasks/);
  assert.match(all, /E\.Bill: quote not found verbatim/);
});

test("export strips provenance; diff reports changes", () => {
  const { fx, corpus } = seeded();
  const before = JSON.parse(fs.readFileSync(path.join(fx.slot, "ontology.json"), "utf8"));
  applyEdits(fx.slot, [{ op: "SUPPORT", id: "A.approve_payment", session: "s2", quote: q2Policy.quote }], corpus, { date: DATE });
  const dest = path.join(fx.root, "submission", "skill");
  const r = exportSlot(fx.slot, dest);
  assert.equal(r.elements, 3);
  const lean = JSON.parse(fs.readFileSync(path.join(dest, "ontology.json"), "utf8"));
  assert.ok(lean.elements.every((e) => e.evidence === undefined && e.counterexamples === undefined));
  assert.ok(!fs.readFileSync(path.join(dest, "ontology.json"), "utf8").includes("CLM-1001"));
  assert.deepEqual(fs.readdirSync(dest).sort(), ["ONTOLOGY.md", "SKILL.md", "ontology.json"]);
  const after = JSON.parse(fs.readFileSync(path.join(fx.slot, "ontology.json"), "utf8"));
  assert.deepEqual(diffOntologies(before, after).promoted, ["A.approve_payment"]);
});

test("skill versions", () => {
  assert.equal(nextSkillVersion("2026.11.12.3", "2026-11-12"), "2026.11.12.4");
  assert.equal(nextSkillVersion("2026.11.11.3", "2026-11-12"), "2026.11.12.1");
  assert.equal(nextSkillVersion(undefined, "2026-11-12"), "2026.11.12.1");
});

test("CLI: extract, apply, validate exit codes", () => {
  const fx = fixture();
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(run("init", fx.slot, "--date", DATE).status, 0);
  const x = run("extract", "--session", "s1", "--agent-dir", fx.agentDir, "--task", "train_001", "--out", fx.corpusDir, "--log", path.join(fx.root, "s1.log"));
  assert.equal(x.status, 0, x.stderr);
  assert.equal(JSON.parse(x.stdout).sources, 5);
  const judge = path.join(fx.root, "judge.json");
  fs.writeFileSync(judge, JSON.stringify({ score: 0.6, feedback: "The decision ignored a void linked bill." }));
  assert.equal(run("extract-judge", "--response", judge, "--task", "train_001", "--attempt", "1", "--out", fx.corpusDir).status, 0);
  const edits = path.join(fx.root, "edits.json");
  fs.writeFileSync(
    edits,
    JSON.stringify({
      operations: [
        { op: "ADD", element: CLAIM, evidence: [q1Claim] },
        { op: "ADD", element: BILL, evidence: [q1Bill] },
        { op: "ADD", element: PAY, evidence: [{ session: "judge:train_001:1", quote: "ignored a void linked bill" }] },
      ],
    }),
  );
  const a = run("apply", fx.slot, edits, "--corpus", fx.corpusDir, "--snapshots", path.join(fx.root, "snaps"), "--date", DATE);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout).published, true, a.stdout);
  assert.ok(fs.existsSync(path.join(fx.root, "snaps", "v1.json")));
  assert.equal(run("validate", fx.slot, "--corpus", fx.corpusDir).status, 0);
  fs.appendFileSync(path.join(fx.slot, "ONTOLOGY.md"), "tampered\n");
  assert.equal(run("validate", fx.slot, "--corpus", fx.corpusDir).status, 1);
  assert.equal(run("bogus").status, 2);
});
