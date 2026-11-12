#!/usr/bin/env node
// onto.mjs: the deterministic half of the Ontology RSI Toolkit. Plain Node, built-ins only.
//
// The Ontologist (a model) proposes typed edits; this script decides whether they are published.
// It owns every rule that must not depend on a model's judgement: the schema, referential
// integrity, verbatim evidence, the instance-id barrier, the lifecycle (candidate → active) and
// the token budget. Run `node onto.mjs --help` for the commands.
//
// A learning slot is a Skill folder in the Target's State:
//   SKILL.md       fixed reader body, versioned frontmatter
//   ontology.json  the single source of truth (elements with provenance)
//   ONTOLOGY.md    the view the Target reads, rendered from ontology.json
//   CHANGELOG.md   one entry per publication, no quotes
//
// A corpus directory holds what `extract` pulled from Traces and judge replies, one JSON file per
// source. Evidence quotes are checked against it, and its instance ids feed the barrier.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORMAT = "ontology-rsi-toolkit/1";
export const SLOT_SKILL = "domain-ontology";
export const DEFAULT_BUDGET = 6000;
export const CHARS_PER_TOKEN = 4;
const QUOTE_MIN = 8;
const QUOTE_MAX = 600;
const PROBE_TASK = "probe";

export const KINDS = {
  entity: "E",
  relation: "R",
  lifecycle: "L",
  precedence: "P",
  action: "A",
  constraint: "C",
};
const KIND_ORDER = Object.keys(KINDS);
const PREFIX_KIND = Object.fromEntries(Object.entries(KINDS).map(([k, p]) => [p, k]));
/** Kinds whose content is read off data. Everything else is policy, and policy starts as a candidate. */
const STRUCTURAL = new Set(["entity", "relation", "lifecycle"]);
const ID_RE = /^[ERLPAC]\.[A-Za-z][A-Za-z0-9_]{1,63}$/;
const REF_RE = /(?<![A-Za-z0-9_.])[ERLPAC]\.[A-Za-z][A-Za-z0-9_]{1,63}(?![A-Za-z0-9_])/g;
const STATUSES = new Set(["candidate", "active", "retired"]);
const ORIGINS = new Set(["observed", "inferred"]);
const META = new Set([
  "id",
  "kind",
  "scope",
  "status",
  "origin",
  "support",
  "evidence",
  "counterexamples",
  "created",
  "updated",
  "merged_into",
  "retired_reason",
]);

/**
 * Content fields per kind. Types: str, strs (list of strings), map (string → string),
 * enums (string → list of strings), ref (an E. id), refs (list of E. ids), refmap (string → E. id),
 * transitions ([{from, to, when?}]), int, card (cardinality).
 */
export const FIELDS = {
  entity: {
    name: "str",
    description: "str",
    source: "strs",
    key: "str",
    fields: "map",
    enums: "enums",
  },
  relation: { from: "ref", to: "ref", via: "str", cardinality: "card", description: "str" },
  lifecycle: {
    entity: "ref",
    field: "str",
    states: "strs",
    transitions: "transitions",
    terminal: "strs",
    description: "str",
  },
  precedence: { entity: "ref", prefer: "str", over: "str", when: "str", description: "str" },
  action: {
    name: "str",
    description: "str",
    params: "refmap",
    preconditions: "strs",
    effects: "strs",
    requires_evidence: "refs",
    order: "int",
    failure_signatures: "strs",
  },
  constraint: { rule: "str", entities: "refs", check: "str", description: "str" },
};
const REQUIRED = {
  entity: ["name", "source"],
  relation: ["from", "to", "via"],
  lifecycle: ["entity", "field", "states"],
  precedence: ["prefer", "over"],
  action: ["name", "preconditions"],
  constraint: ["rule"],
};
const CARDINALITIES = new Set(["1:1", "1:n", "n:1", "n:m"]);

export const READER_BODY = `# Domain ontology

ONTOLOGY.md beside this file is a typed model of the domain you work in, learned from earlier runs: record types and where they live, how they relate, the states they move through, which source wins when two disagree, the contract of each business action, and the constraints that hold across records. It describes the domain, not any one task.

1. Read ONTOLOGY.md before your first substantive action.
2. Find records through the sources its entities name. When two sources disagree, apply its precedence entries.
3. Before you submit, check every business decision in your answer against the preconditions and required evidence of the matching action, and fetch any evidence you have not seen yet.
4. Entries marked candidate are unconfirmed: check them against data before you rely on them. When an entry conflicts with the task's own instructions or with data you fetched, the task and the data win.
5. Before you finish, write the ids of the entries you actually relied on, one per line, to ontology-used.txt in this Session's scratchpad. Leave out entries you only read.

Keep this folder unchanged during a task. Do not read ontology.json, experiment records or any scoring material.
`;

const SKILL_DESCRIPTION =
  "Typed model of this agent's working domain (record types, relations, lifecycles, source precedence, action contracts, constraints), learned from its own runs. Read it before the first substantive action of any task in this domain.";

/** Conditional, so the same line can sit in a baseline State that has no slot. */
export const AGENTS_LINE =
  "If skills/domain-ontology/SKILL.md is installed in your Agent State, read it before your first substantive action in any task and follow it.";

// ---------------------------------------------------------------------------------------------
// Small helpers

const norm = (s) => String(s).replace(/\s+/g, " ").trim();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const today = () => new Date().toISOString().slice(0, 10);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-token occurrence: not glued to letters, digits, `_` or `-` on either side. */
function containsToken(haystack, token) {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(token)}(?![A-Za-z0-9_-])`).test(haystack);
}

export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------------------------
// Slot files

export function emptyOntology(budget = DEFAULT_BUDGET) {
  return { format: FORMAT, version: 0, budget_tokens: budget, elements: [] };
}

function skillMd(version) {
  return `---\nname: ${SLOT_SKILL}\ndescription: ${SKILL_DESCRIPTION}\nversion: ${version}\n---\n\n${READER_BODY}`;
}

/** `YYYY.MM.DD.N`: the next N when the version already carries this date, else this date's `.1`. */
export function nextSkillVersion(current, date) {
  const stamp = date.replace(/-/g, ".");
  const m = /^(\d{4}\.\d{2}\.\d{2})\.(\d+)$/.exec(current || "");
  if (m && m[1] === stamp) return `${stamp}.${Number(m[2]) + 1}`;
  return `${stamp}.1`;
}

function parseSkillMd(text) {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const front = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]] = kv[2];
  }
  return { front, body: m[2] };
}

export function loadSlot(slot) {
  const onto = readJson(path.join(slot, "ontology.json"));
  const skillText = fs.readFileSync(path.join(slot, "SKILL.md"), "utf8");
  return { onto, skill: parseSkillMd(skillText), skillText };
}

// ---------------------------------------------------------------------------------------------
// Corpus

/**
 * Loads every corpus file in `dir`. Returns sessions (id → {task, kind, text}), the forbidden
 * instance ids with the reason for each, and the task labels seen.
 */
export function loadCorpus(dir) {
  const sessions = new Map();
  const idTasks = new Map(); // instance id → Set(task)
  const subjects = new Set(); // ids named in a task's own input: always forbidden
  const tasks = new Set();
  if (!dir || !fs.existsSync(dir)) return { sessions, forbidden: new Map(), tasks };
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const rec = readJson(path.join(dir, name));
    const text = norm((rec.sources || []).map((s) => s.text).join("\n"));
    sessions.set(rec.session, {
      task: rec.task,
      kind: rec.kind,
      text,
      used: new Set(rec.used || []),
    });
    if (rec.task && rec.task !== PROBE_TASK) tasks.add(rec.task);
    for (const id of rec.instance_ids || []) {
      if (!idTasks.has(id)) idTasks.set(id, new Set());
      if (rec.task && rec.task !== PROBE_TASK) idTasks.get(id).add(rec.task);
    }
    for (const id of rec.subject_ids || []) subjects.add(id);
  }
  const forbidden = new Map();
  for (const t of tasks) forbidden.set(t, "task label");
  for (const id of subjects) forbidden.set(id, "named in a task's input");
  for (const [id, ts] of idTasks) {
    // A value seen in one task only is that task's instance; one seen across tasks is shared
    // reference data of the domain (a policy code, a rate schedule) and may be named.
    if (ts.size <= 1 && !forbidden.has(id)) forbidden.set(id, "record id seen in a single task");
  }
  return { sessions, forbidden, tasks };
}

function checkQuote(corpus, ev) {
  if (!isObj(ev)) return "evidence must be an object {session, quote}";
  if (typeof ev.session !== "string" || !ev.session) return "evidence needs a session";
  if (typeof ev.quote !== "string") return "evidence needs a quote";
  const q = norm(ev.quote);
  if (q.length < QUOTE_MIN) return `quote shorter than ${QUOTE_MIN} characters`;
  if (q.length > QUOTE_MAX) return `quote longer than ${QUOTE_MAX} characters`;
  const s = corpus.sessions.get(ev.session);
  if (!s) return `session ${ev.session} is not in the corpus`;
  if (!s.text.includes(q)) return `quote not found verbatim in session ${ev.session}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Element checks

function typeError(kind, field, type, v) {
  const ok = (() => {
    switch (type) {
      case "str":
        return typeof v === "string" && norm(v).length > 0;
      case "strs":
        return Array.isArray(v) && v.every((x) => typeof x === "string" && norm(x).length > 0);
      case "map":
        return isObj(v) && Object.values(v).every((x) => typeof x === "string");
      case "enums":
        return (
          isObj(v) &&
          Object.values(v).every((x) => Array.isArray(x) && x.every((y) => typeof y === "string"))
        );
      case "ref":
        return typeof v === "string" && /^E\./.test(v) && ID_RE.test(v);
      case "refs":
        return Array.isArray(v) && v.every((x) => typeof x === "string" && /^E\./.test(x) && ID_RE.test(x));
      case "refmap":
        return isObj(v) && Object.values(v).every((x) => typeof x === "string" && /^E\./.test(x) && ID_RE.test(x));
      case "transitions":
        return (
          Array.isArray(v) &&
          v.every(
            (t) =>
              isObj(t) &&
              typeof t.from === "string" &&
              typeof t.to === "string" &&
              (t.when === undefined || typeof t.when === "string"),
          )
        );
      case "int":
        return Number.isInteger(v) && v >= 0;
      case "card":
        return CARDINALITIES.has(v);
      default:
        return false;
    }
  })();
  return ok ? null : `${kind}.${field} must be ${type}`;
}

/** Content-only checks of one element: fields known, types right, required present. */
export function checkContent(el) {
  const errors = [];
  const spec = FIELDS[el.kind];
  if (!spec) return [`unknown kind ${el.kind}`];
  for (const [k, v] of Object.entries(el)) {
    if (META.has(k)) continue;
    if (!(k in spec)) {
      errors.push(`${el.kind} has no field ${k}`);
      continue;
    }
    const e = typeError(el.kind, k, spec[k], v);
    if (e) errors.push(e);
  }
  for (const k of REQUIRED[el.kind]) if (el[k] === undefined) errors.push(`${el.kind} needs ${k}`);
  if (el.kind === "lifecycle" && Array.isArray(el.states)) {
    const states = new Set(el.states);
    for (const t of el.transitions || []) {
      if (!states.has(t.from) || !states.has(t.to))
        errors.push(`transition ${t.from} → ${t.to} uses a state not in states`);
    }
    for (const t of el.terminal || []) if (!states.has(t)) errors.push(`terminal ${t} is not in states`);
  }
  return errors;
}

/** Every id an element points at: structured references plus `X.name` tokens in its text. */
export function referencesOf(el) {
  const refs = new Set();
  const spec = FIELDS[el.kind] || {};
  for (const [k, type] of Object.entries(spec)) {
    const v = el[k];
    if (v === undefined) continue;
    if (type === "ref") refs.add(v);
    else if (type === "refs") v.forEach((x) => refs.add(x));
    else if (type === "refmap") Object.values(v).forEach((x) => refs.add(x));
  }
  for (const text of contentTexts(el)) for (const m of text.matchAll(REF_RE)) refs.add(m[0]);
  refs.delete(el.id);
  return refs;
}

/** All human-readable strings of an element's content and scope. */
function contentTexts(el) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) (out.push(k), walk(x));
  };
  for (const [k, v] of Object.entries(el)) {
    if (META.has(k) && k !== "scope") continue;
    walk(v);
  }
  return out;
}

function forbiddenIn(el, forbidden) {
  const text = contentTexts(el).join("\n");
  const hits = [];
  for (const [id, why] of forbidden) {
    if (text.includes(id) && containsToken(text, id)) hits.push(`${id} (${why})`);
  }
  return hits;
}

function liveIds(onto) {
  return new Set(onto.elements.filter((e) => e.status !== "retired").map((e) => e.id));
}

function refErrors(el, onto) {
  const live = liveIds(onto);
  const errors = [];
  for (const r of referencesOf(el)) {
    if (!live.has(r)) errors.push(`references ${r}, which is not a live element`);
  }
  return errors;
}

function referrersOf(id, onto) {
  return onto.elements
    .filter((e) => e.status !== "retired" && e.id !== id && referencesOf(e).has(id))
    .map((e) => e.id);
}

// ---------------------------------------------------------------------------------------------
// Support and lifecycle

/** A quote, or a declared use that scored 100 or beat the previous attempt at the same task. */
function isPositive(ev) {
  if (ev.type === "use") return ev.score === 100 || ev.improved === true;
  return true;
}

export function supportOf(el) {
  const tasks = new Set();
  for (const ev of el.evidence || []) {
    if (ev.task && ev.task !== PROBE_TASK && isPositive(ev)) tasks.add(ev.task);
  }
  return tasks.size;
}

/** Candidate → active: at least two distinct tasks, or a retry of the same task that scored higher while using it. */
function promoteIfDue(el) {
  el.support = supportOf(el);
  if (el.status !== "candidate") return false;
  const improved = (el.evidence || []).some((ev) => ev.type === "use" && ev.improved === true);
  if (el.support >= 2 || improved) {
    el.status = "active";
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Render

const statusTag = (el) =>
  el.status === "candidate" ? `candidate · support ${el.support} · verify against data first` : `active · support ${el.support}`;

function line(label, value) {
  return value === undefined || value === "" ? null : `${label}: ${value}`;
}

function renderElement(el) {
  const head = `### ${el.id} · ${statusTag(el)}${el.scope && el.scope !== "global" ? ` · scope: ${el.scope}` : ""}`;
  const rows = [];
  switch (el.kind) {
    case "entity":
      rows.push(line("Name", el.name));
      rows.push(line("Source", (el.source || []).join("; ")));
      rows.push(line("Key", el.key));
      if (el.fields)
        rows.push(
          line(
            "Fields",
            Object.entries(el.fields)
              .map(([k, v]) => (v ? `${k} (${v})` : k))
              .join(", "),
          ),
        );
      if (el.enums)
        for (const [k, vs] of Object.entries(el.enums)) rows.push(line(`Values of ${k}`, vs.join(", ")));
      break;
    case "relation":
      rows.push(`${el.from} → ${el.to}${el.cardinality ? ` (${el.cardinality})` : ""} via ${el.via}`);
      break;
    case "lifecycle":
      rows.push(line("Field", `${el.entity}.${el.field}`));
      rows.push(line("States", el.states.join(", ")));
      if (el.transitions?.length)
        rows.push(
          line(
            "Transitions",
            el.transitions.map((t) => `${t.from} → ${t.to}${t.when ? ` when ${t.when}` : ""}`).join("; "),
          ),
        );
      if (el.terminal?.length) rows.push(line("Terminal", el.terminal.join(", ")));
      break;
    case "precedence":
      if (el.entity) rows.push(line("Applies to", el.entity));
      rows.push(line("Prefer", el.prefer));
      rows.push(line("Over", el.over));
      rows.push(line("When", el.when));
      break;
    case "action":
      rows.push(line("Action", el.name));
      if (el.order !== undefined) rows.push(line("Order", String(el.order)));
      if (el.params)
        rows.push(
          line(
            "Params",
            Object.entries(el.params)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", "),
          ),
        );
      for (const p of el.preconditions || []) rows.push(`- Requires: ${p}`);
      for (const p of el.effects || []) rows.push(`- Effect: ${p}`);
      if (el.requires_evidence?.length) rows.push(line("Evidence to fetch", el.requires_evidence.join(", ")));
      for (const p of el.failure_signatures || []) rows.push(`- Fails when: ${p}`);
      break;
    case "constraint":
      rows.push(line("Rule", el.rule));
      if (el.entities?.length) rows.push(line("Involves", el.entities.join(", ")));
      rows.push(line("Check", el.check));
      break;
  }
  if (el.description) rows.push(el.description);
  return [head, ...rows.filter(Boolean)].join("\n");
}

const SECTION = {
  entity: "Entities",
  relation: "Relations",
  lifecycle: "Lifecycles",
  precedence: "Source precedence",
  action: "Actions",
  constraint: "Constraints",
};

export function render(onto) {
  const live = onto.elements.filter((e) => e.status !== "retired");
  const out = [
    `# Domain ontology · v${onto.version}`,
    "",
    "Generated from ontology.json; do not edit. Ids are stable: cite the ones you rely on in ontology-used.txt. `active` entries are confirmed by data or by repeated success; `candidate` entries are not, so check them against data before relying on them.",
  ];
  if (live.length === 0) {
    out.push("", "Nothing has been learned yet.");
  }
  for (const kind of KIND_ORDER) {
    const els = live
      .filter((e) => e.kind === kind)
      .sort((a, b) =>
        kind === "action" && a.order !== b.order
          ? (a.order ?? 1e9) - (b.order ?? 1e9)
          : a.id.localeCompare(b.id),
      );
    if (els.length === 0) continue;
    out.push("", `## ${SECTION[kind]}`);
    for (const el of els) out.push("", renderElement(el));
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Apply

function contentOf(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !META.has(k)));
}

function quoteEvidence(corpus, list, label) {
  if (!Array.isArray(list) || list.length === 0) return { error: `${label} needs at least one quote` };
  const out = [];
  for (const ev of list) {
    const err = checkQuote(corpus, ev);
    if (err) return { error: err };
    out.push({ type: "quote", session: ev.session, task: corpus.sessions.get(ev.session).task, quote: norm(ev.quote) });
  }
  return { evidence: out };
}

/**
 * Applies one operation to `onto` in place. Returns {ok, summary} or {ok: false, reason}.
 * Every check runs before the first mutation, so a rejected operation changes nothing.
 */
export function applyOp(onto, op, corpus, version) {
  const byId = new Map(onto.elements.map((e) => [e.id, e]));
  const get = (id) => byId.get(id);
  const live = (id) => get(id) && get(id).status !== "retired";
  const fail = (reason) => ({ ok: false, reason });
  if (!isObj(op) || typeof op.op !== "string") return fail("operation must be an object with op");

  switch (op.op) {
    case "ADD": {
      const el = op.element;
      if (!isObj(el)) return fail("ADD needs element");
      if (typeof el.id !== "string" || !ID_RE.test(el.id)) return fail(`bad id ${el.id}`);
      if (PREFIX_KIND[el.id[0]] !== el.kind) return fail(`id prefix ${el.id[0]} does not match kind ${el.kind}`);
      if (get(el.id)) return fail(`${el.id} exists${get(el.id).status === "retired" ? " (retired ids are never reused)" : ""}`);
      const origin = el.origin ?? (STRUCTURAL.has(el.kind) ? "observed" : "inferred");
      if (!ORIGINS.has(origin)) return fail(`origin must be observed or inferred`);
      if (origin === "observed" && !STRUCTURAL.has(el.kind))
        return fail(`${el.kind} is policy: its origin is inferred, and it starts as a candidate`);
      const content = contentOf(el);
      const draft = { id: el.id, kind: el.kind, scope: el.scope ?? "global", ...content };
      const errs = checkContent(draft);
      if (errs.length) return fail(errs.join("; "));
      const q = quoteEvidence(corpus, op.evidence, "ADD");
      if (q.error) return fail(q.error);
      const refs = refErrors(draft, onto);
      if (refs.length) return fail(refs.join("; "));
      const hits = forbiddenIn(draft, corpus.forbidden);
      if (hits.length) return fail(`instance ids in content: ${hits.join(", ")}`);
      const added = {
        ...draft,
        origin,
        status: origin === "observed" ? "active" : "candidate",
        support: 0,
        evidence: q.evidence,
        counterexamples: [],
        created: version,
        updated: version,
      };
      promoteIfDue(added);
      onto.elements.push(added);
      return { ok: true, summary: `ADD ${added.id} (${added.kind}, ${added.status})` };
    }

    case "REFINE": {
      const el = get(op.id);
      if (!live(op.id)) return fail(`${op.id} is not a live element`);
      if (!isObj(op.set) && !Array.isArray(op.unset)) return fail("REFINE needs set and/or unset");
      for (const k of Object.keys(op.set || {})) if (META.has(k)) return fail(`REFINE cannot set ${k}`);
      for (const k of op.unset || []) if (META.has(k) || REQUIRED[el.kind].includes(k)) return fail(`REFINE cannot unset ${k}`);
      const draft = { ...clone(el), ...clone(op.set || {}) };
      for (const k of op.unset || []) delete draft[k];
      const errs = checkContent(draft);
      if (errs.length) return fail(errs.join("; "));
      const q = quoteEvidence(corpus, op.evidence, "REFINE");
      if (q.error) return fail(q.error);
      const refs = refErrors(draft, onto);
      if (refs.length) return fail(refs.join("; "));
      const hits = forbiddenIn(draft, corpus.forbidden);
      if (hits.length) return fail(`instance ids in content: ${hits.join(", ")}`);
      Object.assign(el, clone(op.set || {}));
      for (const k of op.unset || []) delete el[k];
      el.evidence.push(...q.evidence);
      el.updated = version;
      const promoted = promoteIfDue(el);
      return { ok: true, summary: `REFINE ${el.id}${promoted ? " (now active)" : ""}` };
    }

    case "SCOPE": {
      const el = get(op.id);
      if (!live(op.id)) return fail(`${op.id} is not a live element`);
      if (typeof op.scope !== "string" || !norm(op.scope)) return fail("SCOPE needs a scope");
      if (norm(op.scope) === norm(el.scope || "global")) return fail("SCOPE must change the scope");
      const err = checkQuote(corpus, op.counterexample);
      if (err) return fail(`counterexample: ${err}`);
      const hits = forbiddenIn({ ...el, scope: op.scope }, corpus.forbidden);
      if (hits.length) return fail(`instance ids in scope: ${hits.join(", ")}`);
      el.scope = norm(op.scope);
      el.counterexamples.push({
        session: op.counterexample.session,
        task: corpus.sessions.get(op.counterexample.session).task,
        quote: norm(op.counterexample.quote),
        note: op.note ? norm(op.note) : undefined,
      });
      el.updated = version;
      return { ok: true, summary: `SCOPE ${el.id} → ${el.scope}` };
    }

    case "RETIRE": {
      const el = get(op.id);
      if (!live(op.id)) return fail(`${op.id} is not a live element`);
      if (typeof op.reason !== "string" || !norm(op.reason)) return fail("RETIRE needs a reason");
      const by = referrersOf(op.id, onto);
      if (by.length) return fail(`${op.id} is referenced by ${by.join(", ")}; refine or retire those first`);
      if (op.counterexample !== undefined) {
        const err = checkQuote(corpus, op.counterexample);
        if (err) return fail(`counterexample: ${err}`);
        el.counterexamples.push({
          session: op.counterexample.session,
          task: corpus.sessions.get(op.counterexample.session).task,
          quote: norm(op.counterexample.quote),
        });
      }
      el.status = "retired";
      el.retired_reason = norm(op.reason);
      el.updated = version;
      return { ok: true, summary: `RETIRE ${el.id}: ${el.retired_reason}` };
    }

    case "MERGE": {
      const keep = get(op.id);
      if (!live(op.id)) return fail(`${op.id} is not a live element`);
      if (!Array.isArray(op.from) || op.from.length === 0) return fail("MERGE needs from");
      for (const id of op.from) {
        if (id === op.id) return fail("MERGE cannot merge an element into itself");
        if (!live(id)) return fail(`${id} is not a live element`);
        if (get(id).kind !== keep.kind) return fail(`${id} is a ${get(id).kind}, not a ${keep.kind}`);
      }
      for (const k of Object.keys(op.set || {})) if (META.has(k)) return fail(`MERGE cannot set ${k}`);
      const draft = { ...clone(keep), ...clone(op.set || {}) };
      const errs = checkContent(draft);
      if (errs.length) return fail(errs.join("; "));
      const hits = forbiddenIn(draft, corpus.forbidden);
      if (hits.length) return fail(`instance ids in content: ${hits.join(", ")}`);
      // Rewrite references to the merged ids, then check the result as a whole.
      const trial = clone(onto);
      const rename = (v) => (typeof v === "string" && op.from.includes(v) ? op.id : v);
      const rewriteText = (s) => s.replace(REF_RE, (m) => (op.from.includes(m) ? op.id : m));
      for (const e of trial.elements) {
        if (e.status === "retired" || op.from.includes(e.id)) continue;
        const spec = FIELDS[e.kind];
        for (const [k, type] of Object.entries(spec)) {
          if (e[k] === undefined) continue;
          if (type === "ref") e[k] = rename(e[k]);
          else if (type === "refs") e[k] = [...new Set(e[k].map(rename))];
          else if (type === "refmap") for (const p of Object.keys(e[k])) e[k][p] = rename(e[k][p]);
          else if (type === "str") e[k] = rewriteText(e[k]);
          else if (type === "strs") e[k] = e[k].map(rewriteText);
        }
      }
      const tKeep = trial.elements.find((e) => e.id === op.id);
      Object.assign(tKeep, clone(op.set || {}));
      for (const id of op.from) {
        const src = trial.elements.find((e) => e.id === id);
        tKeep.evidence.push(...src.evidence);
        tKeep.counterexamples.push(...src.counterexamples);
        if (src.status === "active") tKeep.status = "active";
        src.status = "retired";
        src.merged_into = op.id;
        src.retired_reason = `merged into ${op.id}`;
        src.updated = version;
      }
      tKeep.updated = version;
      promoteIfDue(tKeep);
      for (const e of trial.elements) {
        if (e.status === "retired") continue;
        const r = refErrors(e, trial);
        if (r.length) return fail(`${e.id} after merge: ${r.join("; ")}`);
      }
      onto.elements = trial.elements;
      return { ok: true, summary: `MERGE ${op.from.join(", ")} → ${op.id}` };
    }

    case "SUPPORT": {
      const el = get(op.id);
      if (!live(op.id)) return fail(`${op.id} is not a live element`);
      const s = corpus.sessions.get(op.session);
      if (!s) return fail(`session ${op.session} is not in the corpus`);
      let ev;
      if (op.quote !== undefined) {
        const err = checkQuote(corpus, { session: op.session, quote: op.quote });
        if (err) return fail(err);
        ev = { type: "quote", session: op.session, task: s.task, quote: norm(op.quote) };
      } else if (isObj(op.use)) {
        if (!s.used.has(op.id)) return fail(`${op.id} is not in the ontology-used.txt of session ${op.session}`);
        const score = op.use.score;
        if (typeof score !== "number" || score < 0 || score > 100) return fail("use.score must be 0–100");
        const prev = op.use.prev_score;
        if (prev !== undefined && (typeof prev !== "number" || prev < 0 || prev > 100))
          return fail("use.prev_score must be 0–100");
        ev = {
          type: "use",
          session: op.session,
          task: s.task,
          score,
          ...(prev !== undefined ? { prev_score: prev } : {}),
          improved: prev !== undefined && score > prev,
        };
        if (!isPositive(ev)) return fail(`a use that scored ${score}${prev !== undefined ? ` after ${prev}` : ""} is not support`);
      } else {
        return fail("SUPPORT needs a quote or a use");
      }
      const before = el.support;
      el.evidence.push(ev);
      el.updated = version;
      const promoted = promoteIfDue(el);
      return {
        ok: true,
        summary: `SUPPORT ${el.id} (${before} → ${el.support}${promoted ? ", now active" : ""})`,
      };
    }

    default:
      return fail(`unknown op ${op.op}`);
  }
}

/** Retires the weakest unreferenced candidates until the rendered view fits the budget. */
function fitBudget(onto) {
  const retired = [];
  for (;;) {
    const tokens = estimateTokens(render(onto));
    if (tokens <= onto.budget_tokens) return { tokens, retired };
    const victim = onto.elements
      .filter((e) => e.status === "candidate" && referrersOf(e.id, onto).length === 0)
      .sort((a, b) => a.support - b.support || a.updated - b.updated || a.created - b.created)[0];
    if (!victim) return { tokens, retired, over: true };
    victim.status = "retired";
    victim.retired_reason = "budget: weakest candidate";
    retired.push(victim.id);
  }
}

export function applyEdits(slot, edits, corpus, opts = {}) {
  const { onto, skill } = loadSlot(slot);
  const work = clone(onto);
  const version = onto.version + 1;
  const ops = Array.isArray(edits) ? edits : edits.operations;
  if (!Array.isArray(ops)) throw new Error("edits must be a list or {operations: [...]}");
  const applied = [];
  const rejected = [];
  ops.forEach((op, index) => {
    const r = applyOp(work, op, corpus, version);
    if (r.ok) applied.push({ index, summary: r.summary });
    else rejected.push({ index, op: op?.op, id: op?.id ?? op?.element?.id, reason: r.reason });
  });
  const result = { published: false, version: onto.version, applied, rejected, auto_retired: [] };
  if (applied.length === 0) return result;
  work.version = version;
  const fit = fitBudget(work);
  result.tokens = fit.tokens;
  result.budget = work.budget_tokens;
  result.auto_retired = fit.retired;
  if (fit.over) {
    result.reason = `rendered view is ${fit.tokens} tokens, over the budget of ${work.budget_tokens}, with no candidate left to drop; consolidate with MERGE or RETIRE`;
    return result;
  }
  if (opts.dryRun) return { ...result, dry_run: true };

  const date = opts.date || today();
  const skillVersion = nextSkillVersion(skill?.front?.version, date);
  const changelog = [
    `## v${version} · ${date}`,
    "",
    ...applied.map((a) => `- ${a.summary}`),
    ...fit.retired.map((id) => `- RETIRE ${id}: budget, weakest candidate`),
    "",
  ].join("\n");
  writeAtomic(path.join(slot, "ontology.json"), `${JSON.stringify(work, null, 2)}\n`);
  writeAtomic(path.join(slot, "ONTOLOGY.md"), render(work));
  writeAtomic(path.join(slot, "SKILL.md"), skillMd(skillVersion));
  fs.appendFileSync(path.join(slot, "CHANGELOG.md"), `\n${changelog}`);
  if (opts.snapshots) {
    fs.mkdirSync(opts.snapshots, { recursive: true });
    fs.copyFileSync(path.join(slot, "ontology.json"), path.join(opts.snapshots, `v${version}.json`));
  }
  return { ...result, published: true, version, skill_version: skillVersion };
}

// ---------------------------------------------------------------------------------------------
// Validate a whole slot

export function validateSlot(slot, corpus) {
  const errors = [];
  const warnings = [];
  let onto;
  let skill;
  try {
    ({ onto, skill } = loadSlot(slot));
  } catch (e) {
    return { ok: false, errors: [`cannot read slot: ${e.message}`], warnings };
  }
  if (onto.format !== FORMAT) errors.push(`format must be ${FORMAT}`);
  if (!Number.isInteger(onto.version) || onto.version < 0) errors.push("version must be a non-negative integer");
  if (!Number.isInteger(onto.budget_tokens) || onto.budget_tokens <= 0) errors.push("budget_tokens must be positive");
  if (!Array.isArray(onto.elements)) return { ok: false, errors: [...errors, "elements must be a list"], warnings };

  const seen = new Set();
  for (const el of onto.elements) {
    const where = el.id || "(no id)";
    if (typeof el.id !== "string" || !ID_RE.test(el.id)) errors.push(`${where}: bad id`);
    if (seen.has(el.id)) errors.push(`${where}: duplicate id`);
    seen.add(el.id);
    if (PREFIX_KIND[el.id?.[0]] !== el.kind) errors.push(`${where}: prefix does not match kind ${el.kind}`);
    if (!STATUSES.has(el.status)) errors.push(`${where}: bad status ${el.status}`);
    if (!ORIGINS.has(el.origin)) errors.push(`${where}: bad origin ${el.origin}`);
    if (!STRUCTURAL.has(el.kind) && el.origin === "observed") errors.push(`${where}: policy cannot be observed`);
    if (el.status === "retired") continue;
    for (const e of checkContent(el)) errors.push(`${where}: ${e}`);
    for (const e of refErrors(el, onto)) errors.push(`${where}: ${e}`);
    const quotes = (el.evidence || []).filter((ev) => ev.type === "quote");
    if (quotes.length === 0) errors.push(`${where}: no quoted evidence`);
    if (corpus.sessions.size === 0) continue;
    for (const ev of quotes) {
      const err = checkQuote(corpus, ev);
      if (err) errors.push(`${where}: ${err}`);
    }
    if (el.support !== supportOf(el)) errors.push(`${where}: support ${el.support} but evidence gives ${supportOf(el)}`);
    if (el.status === "active" && !STRUCTURAL.has(el.kind)) {
      const improved = el.evidence.some((ev) => ev.type === "use" && ev.improved === true);
      if (el.support < 2 && !improved) errors.push(`${where}: active policy without two tasks or an improved retry`);
    }
    const hits = forbiddenIn(el, corpus.forbidden);
    if (hits.length) errors.push(`${where}: instance ids in content: ${hits.join(", ")}`);
  }
  if (corpus.sessions.size === 0) warnings.push("no corpus given: quotes and instance ids were not checked");

  const view = render(onto);
  const tokens = estimateTokens(view);
  if (tokens > onto.budget_tokens) errors.push(`rendered view is ${tokens} tokens, over the budget of ${onto.budget_tokens}`);
  const mdPath = path.join(slot, "ONTOLOGY.md");
  if (!fs.existsSync(mdPath) || fs.readFileSync(mdPath, "utf8") !== view)
    errors.push("ONTOLOGY.md differs from the view rendered from ontology.json");
  if (!skill) errors.push("SKILL.md has no frontmatter");
  else {
    if (skill.front.name !== SLOT_SKILL) errors.push(`SKILL.md name must be ${SLOT_SKILL}`);
    if (skill.body !== READER_BODY) errors.push("SKILL.md body differs from the fixed reader");
  }
  return { ok: errors.length === 0, errors, warnings, version: onto.version, tokens };
}

// ---------------------------------------------------------------------------------------------
// Init and export

export function initSlot(slot, opts = {}) {
  if (fs.existsSync(slot) && fs.readdirSync(slot).length > 0) throw new Error(`${slot} exists and is not empty`);
  fs.mkdirSync(slot, { recursive: true });
  const onto = emptyOntology(opts.budget || DEFAULT_BUDGET);
  const date = opts.date || today();
  fs.writeFileSync(path.join(slot, "ontology.json"), `${JSON.stringify(onto, null, 2)}\n`);
  fs.writeFileSync(path.join(slot, "ONTOLOGY.md"), render(onto));
  fs.writeFileSync(path.join(slot, "SKILL.md"), skillMd(nextSkillVersion("", date)));
  fs.writeFileSync(path.join(slot, "CHANGELOG.md"), `# Changelog\n\n## v0 · ${date}\n\n- Initialized empty.\n`);
  if (opts.agentsMd) {
    const file = opts.agentsMd;
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (!text.split("\n").includes(AGENTS_LINE)) {
      fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${AGENTS_LINE}\n`);
    }
  }
}

/** The deployable copy: reader, view, and ontology.json without provenance or retired elements. */
export function exportSlot(slot, dest) {
  const { onto } = loadSlot(slot);
  fs.mkdirSync(dest, { recursive: true });
  const lean = {
    format: onto.format,
    version: onto.version,
    budget_tokens: onto.budget_tokens,
    elements: onto.elements
      .filter((e) => e.status !== "retired")
      .map((e) => {
        const { evidence, counterexamples, created, updated, merged_into, retired_reason, ...rest } = e;
        return rest;
      }),
  };
  fs.copyFileSync(path.join(slot, "SKILL.md"), path.join(dest, "SKILL.md"));
  fs.copyFileSync(path.join(slot, "ONTOLOGY.md"), path.join(dest, "ONTOLOGY.md"));
  fs.writeFileSync(path.join(dest, "ontology.json"), `${JSON.stringify(lean, null, 2)}\n`);
  return { version: onto.version, elements: lean.elements.length };
}

// ---------------------------------------------------------------------------------------------
// Extract

const ID_KEY_RE = /(^id$|_id$|Id$|_ids$|Ids$|_number$|_no$)/;
// A task's subject as its input names it (CASE-TR-001, CLM-1001). Three or more trailing digits,
// so domain codes such as ICD-10 are not taken for instances.
const SUBJECT_RE = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3,}(?![A-Za-z0-9_-])/g;
const looksLikeId = (v) => typeof v === "string" && v.length >= 3 && v.length <= 64 && /\d/.test(v) && !/\s/.test(v);

function collectIds(value, key, out) {
  if (Array.isArray(value)) value.forEach((v) => collectIds(v, key, out));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) collectIds(v, k, out);
  else if (key && ID_KEY_RE.test(key) && looksLikeId(value)) out.add(value);
}

/** JSON values found in a tool output: the whole text, a line, or the outermost braces. */
function jsonValues(text) {
  const found = [];
  const tryParse = (s) => {
    try {
      found.push(JSON.parse(s));
      return true;
    } catch {
      return false;
    }
  };
  const t = text.trim();
  if (tryParse(t)) return found;
  for (const ln of t.split("\n")) {
    const l = ln.trim();
    if ((l.startsWith("{") || l.startsWith("[")) && l.length > 1) tryParse(l);
  }
  if (found.length) return found;
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ]) {
    const a = t.indexOf(open);
    const b = t.lastIndexOf(close);
    if (a >= 0 && b > a && tryParse(t.slice(a, b + 1))) break;
  }
  return found;
}

function readTrace(file) {
  const records = [];
  for (const ln of fs.readFileSync(file, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    try {
      records.push(JSON.parse(ln));
    } catch {
      // a torn tail line
    }
  }
  return records;
}

/** Root Trace files of a Session, in rotation order. */
export function traceFiles(agentDir, session) {
  const root = path.join(agentDir, "traces");
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const day of fs.readdirSync(root).sort()) {
    const dir = path.join(root, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${session}_`) && f.endsWith(".jsonl")) files.push(path.join(dir, f));
    }
  }
  return files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

const clipText = (s, n) => {
  const flat = String(s);
  return flat.length > n ? `${flat.slice(0, n)}… [${flat.length - n} more characters in the corpus]` : flat;
};

/**
 * Pulls one Session's interaction from its Trace files: the user's input and every tool output
 * go into the corpus verbatim (they are what the environment said); the model's own text is
 * logged but never becomes evidence.
 */
export function extractTrace(files, opts) {
  const sources = [];
  const ids = new Set();
  const subjects = new Set();
  const log = [];
  const names = new Map();
  let session = opts.session;
  for (const file of files) {
    if (!session) session = path.basename(file).replace(/_\d+\.jsonl$/, "");
    for (const r of readTrace(file)) {
      if (!r || (r.origin && r.origin.length) || r.type !== "model_msg" || !r.payload) continue;
      const p = r.payload;
      if (p.type === "text" && p.role === "user") {
        const text = p.text || "";
        if (text.startsWith("[context_summary]") || text.startsWith("<context_summary>")) continue;
        const n = sources.push({ type: "user", text });
        for (const m of text.matchAll(SUBJECT_RE)) subjects.add(m[0]);
        log.push(`[#${n - 1} user] ${clipText(text, opts.clip * 2)}`);
      } else if (p.type === "text" && (p.text || "").trim()) {
        log.push(`[assistant] ${clipText(p.text, opts.clip)}`);
      } else if (p.type === "tool_call") {
        names.set(p.tool_call_id, p.name);
        log.push(`[tool_call ${p.name}] ${clipText(p.arguments || "", Math.min(opts.clip, 800))}`);
      } else if (p.type === "tool_call_output") {
        const tool = names.get(p.tool_call_id) || "tool";
        const status = p.status || "completed";
        const text = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
        const n = sources.push({ type: "tool_output", tool, status, text });
        for (const v of jsonValues(text)) collectIds(v, null, ids);
        log.push(`[#${n - 1} ${tool}${status !== "completed" ? ` · ${status}` : ""}] ${clipText(text, opts.clip)}`);
      }
    }
  }
  return { session, sources, instance_ids: [...ids].sort(), subject_ids: [...subjects].sort(), log };
}

function readUsed(file) {
  if (!file || !fs.existsSync(file)) return [];
  return [
    ...new Set(
      fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => ID_RE.test(s)),
    ),
  ];
}

const safeName = (s) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

export function writeCorpus(outDir, rec) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${safeName(rec.session)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------------------------------------
// Diff and stats

export function diffOntologies(a, b) {
  const A = new Map(a.elements.map((e) => [e.id, e]));
  const B = new Map(b.elements.map((e) => [e.id, e]));
  const out = { added: [], retired: [], promoted: [], changed: [] };
  for (const [id, eb] of B) {
    const ea = A.get(id);
    if (!ea) {
      if (eb.status !== "retired") out.added.push(id);
      continue;
    }
    if (ea.status !== "retired" && eb.status === "retired") out.retired.push(id);
    else if (ea.status === "candidate" && eb.status === "active") out.promoted.push(id);
    else if (JSON.stringify(contentOf(ea)) !== JSON.stringify(contentOf(eb)) || ea.scope !== eb.scope)
      out.changed.push(id);
  }
  return out;
}

export function stats(onto) {
  const counts = {};
  for (const e of onto.elements) {
    counts[e.kind] ??= { active: 0, candidate: 0, retired: 0 };
    counts[e.kind][e.status] += 1;
  }
  return { version: onto.version, tokens: estimateTokens(render(onto)), budget: onto.budget_tokens, counts };
}

// ---------------------------------------------------------------------------------------------
// CLI

const HELP = `onto.mjs: deterministic tools of the Ontology RSI Toolkit (Node built-ins only)

  init <slot> [--agents-md <AGENTS.md>] [--budget <tokens>]
      Create an empty learning slot; append the fixed reader line to AGENTS.md when given.
  extract (--trace <file>... | --session <id> --agent-dir <agent dir>) --task <label> --out <corpus dir>
          [--used <ontology-used.txt>] [--log <file>] [--clip <chars>]
      Pull one Session's input and tool outputs into the corpus; print or save the condensed log.
      Use --task probe for your own read-only probes: they never count as task support.
  extract-judge --response <file> --task <label> --attempt <n> --out <corpus dir>
      Add a training judge reply to the corpus as session judge:<task>:<n>.
  apply <slot> <edits.json> --corpus <dir> [--snapshots <dir>] [--date YYYY-MM-DD] [--dry-run]
      Apply typed edits (ADD REFINE SCOPE RETIRE MERGE SUPPORT); publish what passes.
  validate <slot> [--corpus <dir>]      Check every invariant of a slot. Exit 1 on an error.
  render <slot>                         Rewrite ONTOLOGY.md from ontology.json.
  export <slot> <dest>                  Write the deployable copy (no provenance) to dest.
  diff <a.json> <b.json>                Added, retired, promoted and changed ids.
  stats <slot>                          Counts per kind and status, and the token estimate.

Every command prints JSON on stdout.`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const vals = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) vals.push(argv[++i]);
      flags[key] = vals.length === 0 ? true : vals.length === 1 ? vals[0] : vals;
    } else pos.push(a);
  }
  return { pos, flags };
}

const list = (v) => (v === undefined || v === true ? [] : Array.isArray(v) ? v : [v]);
const print = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

export function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  switch (cmd) {
    case "init": {
      if (!pos[0]) throw new Error("init needs <slot>");
      initSlot(pos[0], {
        agentsMd: typeof flags["agents-md"] === "string" ? flags["agents-md"] : undefined,
        budget: flags.budget ? Number(flags.budget) : undefined,
        date: typeof flags.date === "string" ? flags.date : undefined,
      });
      print({ ok: true, slot: pos[0] });
      return 0;
    }
    case "extract": {
      if (typeof flags.task !== "string") throw new Error("extract needs --task");
      if (typeof flags.out !== "string") throw new Error("extract needs --out");
      let files = list(flags.trace);
      const session = typeof flags.session === "string" ? flags.session : undefined;
      if (files.length === 0) {
        if (!session || typeof flags["agent-dir"] !== "string") throw new Error("extract needs --trace or --session with --agent-dir");
        files = traceFiles(flags["agent-dir"], session);
        if (files.length === 0) throw new Error(`no Trace files for session ${session}`);
      }
      const clip = flags.clip ? Number(flags.clip) : 1500;
      const x = extractTrace(files, { session, clip });
      const rec = {
        session: x.session,
        task: flags.task,
        kind: "trace",
        files,
        used: readUsed(typeof flags.used === "string" ? flags.used : undefined),
        instance_ids: x.instance_ids,
        subject_ids: flags.task === PROBE_TASK ? [] : x.subject_ids,
        sources: x.sources,
      };
      const file = writeCorpus(flags.out, rec);
      const logText = `${x.log.join("\n")}\n`;
      if (typeof flags.log === "string") fs.writeFileSync(flags.log, logText);
      print({
        ok: true,
        session: rec.session,
        task: rec.task,
        corpus_file: file,
        sources: rec.sources.length,
        used: rec.used,
        instance_ids: rec.instance_ids.length,
        subject_ids: rec.subject_ids,
        log: typeof flags.log === "string" ? flags.log : logText,
      });
      return 0;
    }
    case "extract-judge": {
      for (const k of ["response", "task", "attempt", "out"])
        if (typeof flags[k] !== "string") throw new Error(`extract-judge needs --${k}`);
      const text = fs.readFileSync(flags.response, "utf8");
      const rec = {
        session: `judge:${flags.task}:${flags.attempt}`,
        task: flags.task,
        kind: "judge",
        files: [flags.response],
        used: [],
        instance_ids: [],
        subject_ids: [],
        sources: [{ type: "judge", text }],
      };
      print({ ok: true, session: rec.session, corpus_file: writeCorpus(flags.out, rec) });
      return 0;
    }
    case "apply": {
      const [slot, editsFile] = pos;
      if (!slot || !editsFile) throw new Error("apply needs <slot> <edits.json>");
      if (typeof flags.corpus !== "string") throw new Error("apply needs --corpus");
      const corpus = loadCorpus(flags.corpus);
      const r = applyEdits(slot, readJson(editsFile), corpus, {
        snapshots: typeof flags.snapshots === "string" ? flags.snapshots : undefined,
        date: typeof flags.date === "string" ? flags.date : undefined,
        dryRun: flags["dry-run"] === true,
      });
      print(r);
      return 0;
    }
    case "validate": {
      if (!pos[0]) throw new Error("validate needs <slot>");
      const r = validateSlot(pos[0], loadCorpus(typeof flags.corpus === "string" ? flags.corpus : undefined));
      print(r);
      return r.ok ? 0 : 1;
    }
    case "render": {
      if (!pos[0]) throw new Error("render needs <slot>");
      const { onto } = loadSlot(pos[0]);
      writeAtomic(path.join(pos[0], "ONTOLOGY.md"), render(onto));
      print({ ok: true, tokens: estimateTokens(render(onto)) });
      return 0;
    }
    case "export": {
      const [slot, dest] = pos;
      if (!slot || !dest) throw new Error("export needs <slot> <dest>");
      print({ ok: true, ...exportSlot(slot, dest) });
      return 0;
    }
    case "diff": {
      const [a, b] = pos;
      if (!a || !b) throw new Error("diff needs <a.json> <b.json>");
      print(diffOntologies(readJson(a), readJson(b)));
      return 0;
    }
    case "stats": {
      if (!pos[0]) throw new Error("stats needs <slot>");
      print(stats(loadSlot(pos[0]).onto));
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}; see --help`);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`onto.mjs: ${e.message}\n`);
    process.exitCode = 2;
  }
}
