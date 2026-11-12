#!/usr/bin/env node
// onto.mjs: the deterministic half of the Ontology RSI Toolkit. Plain Node, built-ins only.
//
// The Ontologist (a model) proposes; this script decides. It owns every rule that must not
// depend on a model's judgement:
//   - structure (entities, relations, lifecycles) is published only with a verbatim quote of
//     what the environment said;
//   - policy (precedence, actions, constraints) is a hypothesis about what an answer field
//     should be. It reaches the Actor only after an experiment confirms it: the script changes
//     that field in a saved answer, asks the training judge, and compares the two scores. The
//     prediction is an argument of the command, so it is fixed before the judge is called;
//   - nothing that names an instance of a single task is published, and the rendered view
//     stays within a token budget.
// Run `node onto.mjs --help` for the commands.
//
// A learning slot is a Skill folder in the Target's State:
//   SKILL.md       fixed reader body, versioned frontmatter
//   ontology.json  the single source of truth (elements with provenance)
//   ONTOLOGY.md    the view the Target reads: active elements only
//   CHANGELOG.md   one entry per publication, no quotes
// A work directory holds the run's records: corpus/ (what `extract` pulled from Traces),
// judge/ (one file per distinct answer judged), localize/, experiments.jsonl, records.jsonl.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORMAT = "ontology-rsi-toolkit/2";
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
const PREFIX_KIND = Object.fromEntries(Object.entries(KINDS).map(([k, p]) => [p, k]));
/** Kinds read off data. The other three are policy: hypotheses that an experiment must confirm. */
const STRUCTURAL = new Set(["entity", "relation", "lifecycle"]);
const isPolicy = (kind) => !STRUCTURAL.has(kind);
const ID_RE = /^[ERLPAC]\.[A-Za-z][A-Za-z0-9_]{1,63}$/;
const REF_RE = /(?<![A-Za-z0-9_.])[ERLPAC]\.[A-Za-z][A-Za-z0-9_]{1,63}(?![A-Za-z0-9_])/g;
const STATUSES = new Set(["candidate", "active", "retired"]);
const META = new Set([
  "id",
  "kind",
  "scope",
  "status",
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
 * enums (string → list of strings), ref (an E. id), refs, refmap (string → E. id),
 * transitions ([{from, to, when?}]), int, card (cardinality).
 * `decides` lists the answer fields a policy element determines, as dotted paths.
 */
export const FIELDS = {
  entity: { name: "str", description: "str", source: "strs", key: "str", fields: "map", enums: "enums" },
  relation: { from: "ref", to: "ref", via: "str", cardinality: "card", description: "str" },
  lifecycle: {
    entity: "ref",
    field: "str",
    states: "strs",
    transitions: "transitions",
    terminal: "strs",
    description: "str",
  },
  precedence: { decides: "strs", entity: "ref", prefer: "str", over: "str", when: "str", description: "str" },
  action: {
    decides: "strs",
    name: "str",
    description: "str",
    params: "refmap",
    preconditions: "strs",
    effects: "strs",
    requires_evidence: "refs",
    order: "int",
    failure_signatures: "strs",
  },
  constraint: { decides: "strs", rule: "str", entities: "refs", check: "str", description: "str" },
};
const REQUIRED = {
  entity: ["name", "source"],
  relation: ["from", "to", "via"],
  lifecycle: ["entity", "field", "states"],
  precedence: ["decides", "prefer", "over"],
  action: ["decides", "name", "preconditions"],
  constraint: ["decides", "rule"],
};
const CARDINALITIES = new Set(["1:1", "1:n", "n:1", "n:m"]);

export const READER_BODY = `# Domain ontology

ONTOLOGY.md beside this file is a typed model of the domain you work in, learned from earlier runs. Its structure entries say which record types exist, where they live and how they link. Its policy entries say what an answer field must be and why; each was confirmed by experiment on earlier tasks and names the answer fields it decides. It describes the domain, not any one task.

1. Read ONTOLOGY.md before your first substantive action.
2. Find records through the sources its entities name.
3. Before you submit, go through the policy entries whose scope fits this task. For every answer field an entry decides, make your answer follow the entry, and fetch any record it needs that you have not seen yet.
4. When an entry conflicts with the task's own instructions or with data you fetched, the task and the data win.
5. Before you finish, write the ids of the entries you actually relied on, one per line, to ontology-used.txt in this Session's scratchpad. Leave out entries you only read.

Keep this folder unchanged during a task. Do not read ontology.json, experiment records or any scoring material.
`;

const SKILL_DESCRIPTION =
  "Typed model of this agent's working domain (record types, relations, lifecycles, source precedence, action contracts, constraints), learned from its own runs and confirmed by experiment. Read it before the first substantive action of any task in this domain.";

/** Conditional, so the same line can sit in a baseline State that has no slot. */
export const AGENTS_LINE =
  "If skills/domain-ontology/SKILL.md is installed in your Agent State, read it before your first substantive action in any task and follow it.";

// ---------------------------------------------------------------------------------------------
// Small helpers

const norm = (s) => String(s).replace(/\s+/g, " ").trim();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const today = () => new Date().toISOString().slice(0, 10);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const round4 = (x) => Math.round(x * 1e4) / 1e4;

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

/** JSON with sorted keys: equal values give equal text, so answers can be hashed and compared. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function safeName(s) {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function appendJsonl(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
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

/** Writes a new version of the slot: ontology.json, the view, the reader's version, the changelog. */
function publish(slot, onto, lines, opts = {}) {
  const { skill } = loadSlot(slot);
  const date = opts.date || today();
  const skillVersion = nextSkillVersion(skill?.front?.version, date);
  writeAtomic(path.join(slot, "ontology.json"), `${JSON.stringify(onto, null, 2)}\n`);
  writeAtomic(path.join(slot, "ONTOLOGY.md"), render(onto));
  writeAtomic(path.join(slot, "SKILL.md"), skillMd(skillVersion));
  fs.appendFileSync(
    path.join(slot, "CHANGELOG.md"),
    `\n## v${onto.version} · ${date}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`,
  );
  if (opts.snapshots) {
    fs.mkdirSync(opts.snapshots, { recursive: true });
    fs.copyFileSync(path.join(slot, "ontology.json"), path.join(opts.snapshots, `v${onto.version}.json`));
  }
  return skillVersion;
}

// ---------------------------------------------------------------------------------------------
// Corpus

/**
 * Loads every corpus file in `dir`. Returns sessions (id → {task, text, used}), the forbidden
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
    sessions.set(rec.session, { task: rec.task, text, used: new Set(rec.used || []) });
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
  const strs = (x) => Array.isArray(x) && x.every((y) => typeof y === "string" && norm(y).length > 0);
  const ref = (x) => typeof x === "string" && /^E\./.test(x) && ID_RE.test(x);
  const ok = (() => {
    switch (type) {
      case "str":
        return typeof v === "string" && norm(v).length > 0;
      case "strs":
        return strs(v);
      case "map":
        return isObj(v) && Object.values(v).every((x) => typeof x === "string");
      case "enums":
        return isObj(v) && Object.values(v).every(strs);
      case "ref":
        return ref(v);
      case "refs":
        return Array.isArray(v) && v.every(ref);
      case "refmap":
        return isObj(v) && Object.values(v).every(ref);
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
  if (isPolicy(el.kind) && Array.isArray(el.decides) && el.decides.length === 0)
    errors.push(`${el.kind}.decides must name at least one answer field`);
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

function forbiddenIn(el, forbidden) {
  const text = contentTexts(el).join("\n");
  const hits = [];
  for (const [id, why] of forbidden) {
    if (text.includes(id) && containsToken(text, id)) hits.push(`${id} (${why})`);
  }
  return hits;
}

const liveIds = (onto) => new Set(onto.elements.filter((e) => e.status !== "retired").map((e) => e.id));

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

function tasksWith(el, type) {
  const tasks = new Set();
  for (const ev of el.evidence || []) {
    if (ev.type === type && ev.task && ev.task !== PROBE_TASK) tasks.add(ev.task);
  }
  return tasks.size;
}

/**
 * Structure: distinct tasks whose data was quoted. Policy: distinct tasks in which a fresh Actor,
 * given only the rule, gained credit on a field the rule decides. An experiment shows that the
 * value a rule gives earns credit; only a replication shows that the rule itself carries it.
 */
export function supportOf(el) {
  return tasksWith(el, isPolicy(el.kind) ? "replication" : "quote");
}

// ---------------------------------------------------------------------------------------------
// Render: what the Actor reads. Active elements only; a hypothesis never reaches the Actor.

function line(label, value) {
  return value === undefined || value === "" ? null : `${label}: ${value}`;
}

function renderElement(el) {
  const tags = [];
  const n = (k) => `${k} task${k === 1 ? "" : "s"}`;
  if (isPolicy(el.kind))
    tags.push(el.support > 0 ? `reproduced in ${n(el.support)}` : `tested in ${n(tasksWith(el, "experiment"))}, not yet reproduced`);
  if (el.scope && el.scope !== "global") tags.push(`scope: ${el.scope}`);
  const head = `### ${[el.id, ...tags].join(" · ")}`;
  const rows = [];
  if (isPolicy(el.kind)) rows.push(line("Decides", el.decides.join(", ")));
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
// Policy first: it is what changes an answer. Structure follows as the map to the records.
const RENDER_ORDER = ["precedence", "action", "constraint", "entity", "relation", "lifecycle"];

export function render(onto) {
  const active = onto.elements.filter((e) => e.status === "active");
  const out = [
    `# Domain ontology · v${onto.version}`,
    "",
    "Generated from ontology.json; do not edit. Ids are stable: cite the ones you rely on in ontology-used.txt. Structure entries were read off the environment's own records. Policy entries name the answer fields they decide. Each one passed an experiment on the training judge; `reproduced` means that an earlier agent, given only the entry, then gained credit on those fields.",
  ];
  if (active.length === 0) out.push("", "Nothing has been learned yet.");
  for (const kind of RENDER_ORDER) {
    const els = active
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
// Apply: ADD, REFINE, RETIRE, MERGE

const contentOf = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !META.has(k)));
/** What a policy element claims: its content without the free-text description, plus its scope. */
const ruleOf = (el) => canonical({ ...contentOf(el), description: null, scope: el.scope });

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
      const draft = { id: el.id, kind: el.kind, scope: norm(el.scope ?? "global"), ...contentOf(el) };
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
        status: isPolicy(el.kind) ? "candidate" : "active",
        support: 0,
        evidence: q.evidence,
        counterexamples: [],
        created: version,
        updated: version,
      };
      added.support = supportOf(added);
      onto.elements.push(added);
      return {
        ok: true,
        summary: `ADD ${added.id} (${added.kind}, ${added.status === "candidate" ? "hypothesis" : "active"})`,
      };
    }

    case "REFINE": {
      const el = get(op.id);
      if (!live(op.id)) return fail(`${op.id} is not a live element`);
      if (!isObj(op.set) && !Array.isArray(op.unset) && op.scope === undefined)
        return fail("REFINE needs set, unset or scope");
      for (const k of Object.keys(op.set || {})) if (META.has(k)) return fail(`REFINE cannot set ${k}`);
      for (const k of op.unset || []) if (META.has(k) || REQUIRED[el.kind].includes(k)) return fail(`REFINE cannot unset ${k}`);
      if (op.scope !== undefined && (typeof op.scope !== "string" || !norm(op.scope))) return fail("scope must be text");
      const draft = { ...clone(el), ...clone(op.set || {}) };
      for (const k of op.unset || []) delete draft[k];
      if (op.scope !== undefined) draft.scope = norm(op.scope);
      const errs = checkContent(draft);
      if (errs.length) return fail(errs.join("; "));
      // Structure changes with what the data shows, so it needs a new quote. A changed policy is
      // a new hypothesis: no quote can show that it holds, and its confirmations no longer apply.
      let q = { evidence: [] };
      if (!isPolicy(el.kind) || op.evidence !== undefined) {
        q = quoteEvidence(corpus, op.evidence, "REFINE");
        if (q.error) return fail(q.error);
      }
      const refs = refErrors(draft, onto);
      if (refs.length) return fail(refs.join("; "));
      const hits = forbiddenIn(draft, corpus.forbidden);
      if (hits.length) return fail(`instance ids in content: ${hits.join(", ")}`);
      const before = ruleOf(el);
      Object.assign(el, clone(op.set || {}));
      for (const k of op.unset || []) delete el[k];
      if (op.scope !== undefined) el.scope = norm(op.scope);
      el.evidence.push(...q.evidence);
      el.updated = version;
      let note = "";
      if (isPolicy(el.kind) && before !== ruleOf(el)) {
        const had = el.evidence.some((ev) => ev.type !== "quote");
        el.evidence = el.evidence.filter((ev) => ev.type === "quote");
        el.status = "candidate";
        if (had) note = " (rule changed: back to hypothesis, confirm it again)";
      }
      el.support = supportOf(el);
      return { ok: true, summary: `REFINE ${el.id}${note}` };
    }

    case "RETIRE": {
      const el = get(op.id);
      if (!live(op.id)) return fail(`${op.id} is not a live element`);
      if (typeof op.reason !== "string" || !norm(op.reason)) return fail("RETIRE needs a reason");
      const by = referrersOf(op.id, onto);
      if (by.length) return fail(`${op.id} is referenced by ${by.join(", ")}; refine or retire those first`);
      el.status = "retired";
      el.retired_reason = norm(op.reason);
      el.updated = version;
      return { ok: true, summary: `RETIRE ${el.id}: ${el.retired_reason}` };
    }

    case "MERGE": {
      const keep = get(op.id);
      if (!live(op.id)) return fail(`${op.id} is not a live element`);
      if (isPolicy(keep.kind))
        return fail("MERGE is for structure; retire a policy element and add the merged rule as a new hypothesis");
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
        for (const [k, type] of Object.entries(FIELDS[e.kind])) {
          if (e[k] === undefined) continue;
          if (type === "ref") e[k] = rename(e[k]);
          else if (type === "refs") e[k] = [...new Set(e[k].map(rename))];
          else if (type === "refmap") for (const p of Object.keys(e[k])) e[k][p] = rename(e[k][p]);
          else if (type === "str") e[k] = rewriteText(e[k]);
          else if (type === "strs" && k !== "decides") e[k] = e[k].map(rewriteText);
        }
      }
      const tKeep = trial.elements.find((e) => e.id === op.id);
      Object.assign(tKeep, clone(op.set || {}));
      for (const id of op.from) {
        const src = trial.elements.find((e) => e.id === id);
        tKeep.evidence.push(...src.evidence);
        tKeep.counterexamples.push(...src.counterexamples);
        src.status = "retired";
        src.merged_into = op.id;
        src.retired_reason = `merged into ${op.id}`;
        src.updated = version;
      }
      tKeep.updated = version;
      tKeep.support = supportOf(tKeep);
      for (const e of trial.elements) {
        if (e.status === "retired") continue;
        const r = refErrors(e, trial);
        if (r.length) return fail(`${e.id} after merge: ${r.join("; ")}`);
      }
      onto.elements = trial.elements;
      return { ok: true, summary: `MERGE ${op.from.join(", ")} → ${op.id}` };
    }

    default:
      return fail(`unknown op ${op.op}; the operations are ADD, REFINE, RETIRE and MERGE`);
  }
}

function overBudget(onto) {
  const tokens = estimateTokens(render(onto));
  return tokens > onto.budget_tokens
    ? `rendered view is ${tokens} tokens, over the budget of ${onto.budget_tokens}; consolidate with MERGE or RETIRE first`
    : null;
}

export function applyEdits(slot, edits, corpus, opts = {}) {
  const { onto } = loadSlot(slot);
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
  const result = { published: false, version: onto.version, applied, rejected };
  if (applied.length === 0) return result;
  work.version = version;
  result.tokens = estimateTokens(render(work));
  result.budget = work.budget_tokens;
  const over = overBudget(work);
  if (over) return { ...result, reason: over };
  if (opts.dryRun) return { ...result, dry_run: true };
  const skillVersion = publish(
    slot,
    work,
    applied.map((a) => a.summary),
    opts,
  );
  return { ...result, published: true, version, skill_version: skillVersion };
}

// ---------------------------------------------------------------------------------------------
// The judge as an instrument: score an answer, find where credit is lost, test a hypothesis.

/**
 * Judge settings: `{url, body, score_path, scale, budget_per_task}`. In `body`, the string
 * "{task}" becomes the task id and "{answer}" the answer itself. They may sit under a `judge`
 * key of a larger file, such as training-request.json.
 */
export function loadJudgeConfig(file) {
  const raw = readJson(file);
  const cfg = raw.judge ?? raw;
  if (typeof cfg.url !== "string") throw new Error(`${file}: judge.url is missing`);
  return {
    url: cfg.url,
    body: cfg.body ?? { task_id: "{task}", answer: "{answer}" },
    score_path: cfg.score_path ?? "score",
    scale: cfg.scale ?? 100,
    budget_per_task: cfg.budget_per_task ?? null,
  };
}

function fillBody(template, task, answer) {
  if (template === "{task}") return task;
  if (template === "{answer}") return answer;
  if (Array.isArray(template)) return template.map((t) => fillBody(t, task, answer));
  if (isObj(template))
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fillBody(v, task, answer)]));
  return template;
}

/** Asks the judge over HTTP. Tests pass their own `ask` instead. */
async function httpAsk(cfg, task, answer) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fillBody(cfg.body, task, answer)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`judge answered ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * Scores one answer, on the 0–100 scale. Each distinct answer of a task is judged once and its
 * reply kept under work/judge/, so repeating a question costs nothing and the count of files is
 * the count of judge calls. A per-task budget, when set, refuses the call that would exceed it.
 */
export async function judgeAnswer(work, cfg, task, answer, ask = httpAsk, opts = {}) {
  const digest = sha(canonical(answer));
  const dir = path.join(work, "judge");
  const file = path.join(dir, `${safeName(task)}-${digest.slice(0, 16)}.json`);
  if (fs.existsSync(file)) return { ...readJson(file), cached: true };
  fs.mkdirSync(dir, { recursive: true });
  const used = fs.readdirSync(dir).filter((f) => f.startsWith(`${safeName(task)}-`)).length;
  if (!opts.measurement && cfg.budget_per_task !== null && used >= cfg.budget_per_task)
    throw new Error(`judge budget for ${task} is spent (${used} of ${cfg.budget_per_task} calls)`);
  const reply = await ask(cfg, task, answer);
  const raw = cfg.score_path.split(".").reduce((v, k) => (v == null ? v : v[k]), reply);
  if (typeof raw !== "number" || Number.isNaN(raw)) throw new Error(`judge reply has no numeric ${cfg.score_path}`);
  const rec = { task, answer_sha: digest, score: round4(raw * cfg.scale), reply, answer };
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return { ...rec, cached: false };
}

export function judgeCalls(work) {
  const dir = path.join(work, "judge");
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const task = readJson(path.join(dir, f)).task;
    out[task] = (out[task] || 0) + 1;
  }
  return out;
}

const isRecordList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && Object.keys(x).length > 0);

/**
 * Answer fields as paths: `a.b` into objects, `rows[2].status` into a list of records. A list
 * of plain values is one field.
 */
export function leafPaths(value, prefix = "") {
  const out = new Map();
  if (!isObj(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && Object.keys(v).length > 0) for (const [q, c] of leafPaths(v, p)) out.set(q, c);
    else if (isRecordList(v)) v.forEach((item, i) => leafPaths(item, `${p}[${i}]`).forEach((c, q) => out.set(q, c)));
    else out.set(p, canonical(v));
  }
  return out;
}

/** `rows[2].status` → ["rows", 2, "status"]. */
function pathKeys(p) {
  const keys = [];
  for (const part of p.split(".")) {
    const m = /^(.*?)((?:\[\d+\])*)$/.exec(part);
    keys.push(m[1]);
    for (const i of m[2].matchAll(/\[(\d+)\]/g)) keys.push(Number(i[1]));
  }
  return keys;
}

export function changedPaths(a, b) {
  const A = leafPaths(a);
  const B = leafPaths(b);
  return [...new Set([...A.keys(), ...B.keys()])].filter((p) => A.get(p) !== B.get(p)).sort();
}

function getPath(answer, p) {
  let cur = answer;
  for (const k of pathKeys(p)) cur = cur?.[k];
  return cur;
}

function withValue(answer, p, value) {
  const out = clone(answer);
  const keys = pathKeys(p);
  let cur = out;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys.at(-1)] = value;
  return out;
}

function withoutPath(answer, p) {
  const out = clone(answer);
  const keys = pathKeys(p);
  let cur = out;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  delete cur[keys.at(-1)];
  return out;
}

/**
 * Knock-out map of one answer: remove one field at a time and judge again. A drop means the
 * field earned credit. No change means it earned none: it is wrong, or it is not scored alone.
 * Fields of records in a list are removed one record at a time, so a list that is partly right
 * shows which records and which of their fields are wrong.
 * A true/false field without credit is then flipped: if the score rises it was wrong, and if
 * nothing moves it is not scored. Other fields without credit stay undecided between the two.
 */
export async function localize(work, cfg, task, answer, ask) {
  const base = await judgeAnswer(work, cfg, task, answer, ask);
  const credited = [];
  const noCredit = [];
  const penalized = [];
  for (const p of leafPaths(answer).keys()) {
    const s = (await judgeAnswer(work, cfg, task, withoutPath(answer, p), ask)).score;
    if (s < base.score) credited.push({ path: p, delta: round4(s - base.score) });
    else if (s > base.score) penalized.push({ path: p, delta: round4(s - base.score) });
    else noCredit.push(p);
  }
  const wrong = [];
  const unscored = [];
  for (const p of noCredit) {
    const v = getPath(answer, p);
    if (typeof v !== "boolean") continue;
    const s = (await judgeAnswer(work, cfg, task, withValue(answer, p, !v), ask)).score;
    if (s > base.score) wrong.push({ path: p, delta: round4(s - base.score) });
    else if (s === base.score) unscored.push(p);
  }
  const rec = {
    task,
    answer_sha: base.answer_sha,
    score: base.score,
    credited,
    no_credit: noCredit,
    penalized,
    wrong,
    unscored,
  };
  const dir = path.join(work, "localize");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${safeName(task)}-${base.answer_sha.slice(0, 16)}.json`),
    `${JSON.stringify(rec, null, 2)}\n`,
  );
  return rec;
}

/**
 * Fields without credit, counted across tasks, most widespread first. An error that recurs
 * across tasks is a fact about the domain; one seen in a single task may be that task's own.
 * Uses each task's best-scoring localized answer.
 */
export function gaps(work) {
  const dir = path.join(work, "localize");
  const best = new Map();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      const rec = readJson(path.join(dir, f));
      if (!best.has(rec.task) || rec.score > best.get(rec.task).score) best.set(rec.task, rec);
    }
  }
  // Records of a list are counted under one path: rows[2].status and rows[5].status are rows.status.
  const flat = (p) => p.replace(/\[\d+\]/g, "");
  const byPath = new Map();
  const at = (p) => {
    if (!byPath.has(p)) byPath.set(p, { path: p, tasks: new Set(), no_credit: 0, wrong: 0, credited: 0 });
    return byPath.get(p);
  };
  for (const rec of best.values()) {
    const unscored = new Set(rec.unscored || []);
    const wrong = new Set((rec.wrong || []).map((x) => x.path));
    for (const c of rec.credited) at(flat(c.path)).credited += 1;
    for (const p of [...rec.no_credit, ...rec.penalized.map((x) => x.path)]) {
      if (unscored.has(p)) continue;
      const g = at(flat(p));
      g.tasks.add(rec.task);
      g.no_credit += 1;
      if (wrong.has(p)) g.wrong += 1;
    }
  }
  return {
    tasks: [...best.values()]
      .map((r) => ({ task: r.task, score: r.score }))
      .sort((a, b) => a.task.localeCompare(b.task)),
    // `wrong` counts fields a flip proved wrong; `credited` counts places where the same field
    // earned credit, which shows that it is scored at all.
    gaps: [...byPath.values()]
      .filter((g) => g.no_credit > 0)
      .map((g) => ({ ...g, tasks: [...g.tasks].sort() }))
      .sort((a, b) => b.tasks.length - a.tasks.length || b.wrong - a.wrong || b.no_credit - a.no_credit || a.path.localeCompare(b.path)),
  };
}

/** Whether a decided path covers an answer field. `rows.status` covers `rows[2].status`: a rule speaks of every record. */
function covers(decides, p) {
  const flat = p.replace(/\[\d+\]/g, "");
  return decides.some((d) => flat === d || flat.startsWith(`${d}.`) || d.startsWith(`${flat}.`));
}
const signed = (x) => `${x > 0 ? "+" : ""}${x}`;

/**
 * One experiment. `base` and `variant` are two answers to the same task that differ only in
 * fields the tested elements decide. `predict` is fixed before the judge is asked:
 *   better: the variant follows the rule and the base does not, so the variant must score higher;
 *   worse:  the base follows the rule and the variant breaks it, so the variant must score lower.
 * A score that moves as predicted confirms every tested element in this task. One that moves the
 * other way refutes: a single tested element is retired; a bundle is only recorded, because the
 * experiment cannot say which member is wrong. No movement is inconclusive.
 * Without `tests` it is a plain comparison and changes nothing.
 */
export async function runExperiment(slot, work, cfg, spec, opts = {}) {
  const { task, base, variant, predict } = spec;
  const tests = spec.tests || [];
  const { onto } = loadSlot(slot);
  const els = tests.map((id) => onto.elements.find((e) => e.id === id));
  tests.forEach((id, i) => {
    if (!els[i] || els[i].status === "retired") throw new Error(`${id} is not a live element`);
    if (!isPolicy(els[i].kind)) throw new Error(`${id} is structure; experiments test policy`);
  });
  if (tests.length && predict !== "better" && predict !== "worse") throw new Error("predict must be better or worse");
  const changed = changedPaths(base, variant);
  if (changed.length === 0) throw new Error("base and variant are the same answer");
  if (tests.length) {
    const decides = els.flatMap((e) => e.decides);
    const stray = changed.filter((p) => !covers(decides, p));
    if (stray.length)
      throw new Error(`the variant also changes ${stray.join(", ")}, which the tested elements do not decide`);
  }
  const b = await judgeAnswer(work, cfg, task, base, opts.ask);
  const v = await judgeAnswer(work, cfg, task, variant, opts.ask);
  const delta = round4(v.score - b.score);
  let outcome = "compared";
  if (tests.length) {
    const sign = predict === "better" ? delta : -delta;
    outcome = sign > 0 ? "confirmed" : sign < 0 ? "refuted" : "inconclusive";
  }
  const file = path.join(work, "experiments.jsonl");
  const id = `exp:${readJsonl(file).length + 1}`;
  const rec = {
    id,
    task,
    tests,
    predict: tests.length ? predict : null,
    changed,
    base_sha: b.answer_sha,
    variant_sha: v.answer_sha,
    base_score: b.score,
    variant_score: v.score,
    delta,
    outcome,
    ...(spec.note ? { note: norm(spec.note) } : {}),
  };
  appendJsonl(file, rec);

  const next = clone(onto);
  next.version = onto.version + 1;
  const lines = [];
  const pick = (eid) => next.elements.find((e) => e.id === eid);
  if (outcome === "confirmed") {
    for (const eid of tests) {
      const el = pick(eid);
      el.evidence.push({ type: "experiment", id, task });
      el.support = supportOf(el);
      el.updated = next.version;
      const promoted = el.status === "candidate";
      el.status = "active";
      lines.push(`CONFIRM ${eid} (${id}, ${signed(delta)})${promoted ? ": now active" : ""}`);
    }
  } else if (outcome === "refuted" && tests.length === 1) {
    const el = pick(tests[0]);
    el.counterexamples.push({ type: "experiment", id, task });
    el.updated = next.version;
    const by = referrersOf(el.id, next);
    if (by.length) {
      el.status = "candidate";
      el.evidence = el.evidence.filter((ev) => ev.type === "quote");
      el.support = supportOf(el);
      lines.push(`REFUTE ${el.id} (${id}, ${signed(delta)}): back to hypothesis; ${by.join(", ")} refer to it`);
    } else {
      el.status = "retired";
      el.retired_reason = `refuted by ${id}`;
      lines.push(`REFUTE ${el.id} (${id}, ${signed(delta)}): retired`);
    }
  }
  const result = { ...rec, published: false, version: onto.version };
  if (lines.length === 0) return result;
  const over = overBudget(next);
  if (over)
    return {
      ...result,
      reason: `${over}. The experiment is recorded; repeat it after consolidating (it costs no judge call)`,
    };
  publish(slot, next, lines, opts);
  return { ...result, published: true, version: next.version, changes: lines };
}

// ---------------------------------------------------------------------------------------------
// Replication: did an Actor that read only the rule gain credit where the rule decides?

function attemptsByTask(work) {
  const out = {};
  for (const r of readJsonl(path.join(work, "records.jsonl"))) {
    if (r.kind !== "attempt") continue;
    out[r.task] ??= {};
    out[r.task][r.phase] = r; // the last attempt of a task in a phase
  }
  return out;
}

function attemptAnswer(work, rec) {
  const cached = path.join(work, "judge", `${safeName(rec.task)}-${rec.answer_sha.slice(0, 16)}.json`);
  if (fs.existsSync(cached)) {
    const c = readJson(cached);
    if (c.answer !== undefined) return c.answer;
  }
  for (const f of [rec.answer, path.join(work, "attempts", path.basename(rec.answer || ""))]) {
    if (f && fs.existsSync(f)) return readJson(f);
  }
  throw new Error(`the answer of ${rec.task} (${rec.phase}) is not in the records`);
}

/**
 * Compares, per task, the knock-out maps of two attempts: one made before the ontology (`from`)
 * and one made by a fresh Actor reading it (`to`). For each active policy element and each
 * answer field it decides:
 *   gain: the field had no credit before and has it now;
 *   harm: the field had credit before and lost it;
 *   held: credit before and after;  none: no credit before or after.
 * An element is judged in the tasks where its value passed an experiment, so that both gates
 * stand on the same task. One with a gain is marked reproduced in that task. One that moved
 * nothing in any of its tasks goes back to hypothesis: the rule did not reach the Actor. One
 * that only held stays, with no gain shown. An element charged with a harm is retired. One
 * tested only in tasks without a pair of attempts was never replicated and goes back to
 * hypothesis.
 */
export async function replicate(slot, work, cfg, opts = {}) {
  const from = opts.from || "baseline";
  const to = opts.to || "verify";
  const { onto } = loadSlot(slot);
  const deployedDecides = onto.elements
    .filter((e) => e.status === "active" && isPolicy(e.kind))
    .flatMap((e) => e.decides);
  // Only the fields some deployed rule decides are knocked out: replication measures the rules,
  // and a list of many records would otherwise cost hundreds of calls. These calls measure;
  // they do not search, so the per-task budget does not apply to them.
  const maps = {};
  for (const [task, phases] of Object.entries(attemptsByTask(work))) {
    if (!phases[from] || !phases[to]) continue;
    const A = attemptAnswer(work, phases[from]);
    const B = attemptAnswer(work, phases[to]);
    const paths = [...new Set([...leafPaths(A).keys(), ...leafPaths(B).keys()])].filter((p) => covers(deployedDecides, p));
    const credit = async (answer) => {
      const base = (await judgeAnswer(work, cfg, task, answer, opts.ask, { measurement: true })).score;
      const yes = new Set();
      const own = new Set(leafPaths(answer).keys());
      for (const p of paths) {
        if (!own.has(p)) continue;
        const s = (await judgeAnswer(work, cfg, task, withoutPath(answer, p), opts.ask, { measurement: true })).score;
        if (s < base) yes.add(p);
      }
      return { yes, all: new Set(paths) };
    };
    maps[task] = { a: await credit(A), b: await credit(B) };
  }
  if (Object.keys(maps).length === 0) throw new Error(`no task has both a ${from} and a ${to} attempt`);

  const next = clone(onto);
  next.version = onto.version + 1;
  const lines = [];
  const report = [];
  const deployed = next.elements.filter((e) => e.status === "active" && isPolicy(e.kind));
  const testedIn = (el, task) => el.evidence.some((ev) => ev.type === "experiment" && ev.task === task);
  // A field that lost credit is charged to the rules that decide it and were tested in that
  // task; when none was, some rule was applied outside the tasks it was tested in, and every
  // rule that decides the field is charged.
  const blamed = new Map(); // element id → [{task, path}]
  for (const [task, { a, b }] of Object.entries(maps)) {
    for (const p of a.yes) {
      if (b.yes.has(p)) continue;
      const deciders = deployed.filter((e) => covers(e.decides, p));
      const tested = deciders.filter((e) => testedIn(e, task));
      for (const e of tested.length ? tested : deciders) {
        if (!blamed.has(e.id)) blamed.set(e.id, []);
        blamed.get(e.id).push({ task, path: p });
      }
    }
  }
  for (const el of deployed) {
    const row = { id: el.id, tasks: {} };
    for (const { task, path: p } of blamed.get(el.id) || []) {
      row.tasks[task] ??= { outcome: "harm", lost: [] };
      row.tasks[task].lost.push(p);
    }
    // Gains count only where the rule's value passed its experiment: both gates in one task.
    for (const [task, { a, b }] of Object.entries(maps)) {
      if (row.tasks[task] || !testedIn(el, task)) continue;
      const paths = [...new Set([...a.all, ...b.all])].filter((p) => covers(el.decides, p));
      if (paths.length === 0) continue;
      const gained = paths.filter((p) => !a.yes.has(p) && b.yes.has(p));
      const held = paths.filter((p) => a.yes.has(p) && b.yes.has(p));
      const outcome = gained.length ? "gain" : held.length ? "held" : "none";
      row.tasks[task] = { outcome, ...(gained.length ? { gained } : {}) };
    }
    const outcomes = Object.entries(row.tasks);
    const harms = outcomes.filter(([, o]) => o.outcome === "harm");
    const gains = outcomes.filter(([, o]) => o.outcome === "gain");
    if (harms.length) {
      for (const [task, o] of harms) el.counterexamples.push({ type: "replication", task, lost: o.lost });
      const what = harms.map(([task, o]) => `${o.lost.join(", ")} in ${task}`).join("; ");
      if (referrersOf(el.id, next).length) {
        el.status = "candidate";
        el.evidence = el.evidence.filter((ev) => ev.type === "quote");
        lines.push(`HARM ${el.id}: an Actor that followed it lost credit on ${what}; back to hypothesis`);
      } else {
        el.status = "retired";
        el.retired_reason = `harmful in replication: lost credit on ${what}`;
        lines.push(`HARM ${el.id}: an Actor that followed it lost credit on ${what}; retired`);
      }
      row.result = "harm";
    } else if (gains.length) {
      const known = new Set(el.evidence.filter((ev) => ev.type === "replication").map((ev) => ev.task));
      for (const [task, o] of gains) {
        if (!known.has(task)) el.evidence.push({ type: "replication", task, gained: o.gained });
      }
      lines.push(`REPRODUCE ${el.id}: an Actor gained credit on ${gains.map(([task, o]) => `${o.gained.join(", ")} in ${task}`).join("; ")}`);
      row.result = "reproduced";
    } else if (outcomes.length && outcomes.every(([, o]) => o.outcome === "none")) {
      el.status = "candidate";
      lines.push(`DEMOTE ${el.id}: no Actor gained credit on what it decides; back to hypothesis`);
      row.result = "not reproduced";
    } else if (outcomes.length) {
      row.result = "held";
    } else {
      // No task where it was tested has a pair of attempts: it was never replicated, and a rule
      // that has not passed both gates does not reach the Target.
      el.status = "candidate";
      lines.push(`UNREPLICATED ${el.id}: no ${to} attempt in a task where it was tested; back to hypothesis`);
      row.result = "not replicated";
    }
    el.support = supportOf(el);
    if (row.result !== "held") el.updated = next.version;
    report.push(row);
  }
  appendJsonl(path.join(work, "replications.jsonl"), { from, to, version: onto.version, elements: report });
  const result = { from, to, elements: report, published: false, version: onto.version };
  if (lines.length === 0) return result;
  const over = overBudget(next);
  if (over) return { ...result, reason: over };
  publish(slot, next, lines, opts);
  return { ...result, published: true, version: next.version };
}

/**
 * Closes a run from its records alone: checks the slot, writes the deployable copy, copies each
 * task's last attempt as its final answer (the `verify` one when there is one), and writes the
 * summary. It may be run more than once; a later run replaces an earlier export.
 */
export function finish(slot, work, corpusDir, skillDest, answersDest) {
  const check = validateSlot(slot, loadCorpus(corpusDir), work);
  if (!check.ok) return { ok: false, errors: check.errors };
  const exported = exportSlot(slot, skillDest);
  fs.mkdirSync(answersDest, { recursive: true });
  const answers = {};
  for (const [task, phases] of Object.entries(attemptsByTask(work))) {
    const rec = phases.verify || phases.baseline || Object.values(phases).at(-1);
    fs.writeFileSync(path.join(answersDest, `${task}.json`), `${JSON.stringify(attemptAnswer(work, rec), null, 2)}\n`);
    answers[task] = rec.phase;
  }
  const summary = summarize(slot, work);
  fs.writeFileSync(path.join(work, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return { ok: true, exported, answers, summary };
}

// ---------------------------------------------------------------------------------------------
// Validate a whole slot

export function validateSlot(slot, corpus, work) {
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
  const experiments = work
    ? new Map(readJsonl(path.join(work, "experiments.jsonl")).map((x) => [x.id, x]))
    : null;

  const seen = new Set();
  for (const el of onto.elements) {
    const where = el.id || "(no id)";
    if (typeof el.id !== "string" || !ID_RE.test(el.id)) errors.push(`${where}: bad id`);
    if (seen.has(el.id)) errors.push(`${where}: duplicate id`);
    seen.add(el.id);
    if (PREFIX_KIND[el.id?.[0]] !== el.kind) errors.push(`${where}: prefix does not match kind ${el.kind}`);
    if (!STATUSES.has(el.status)) errors.push(`${where}: bad status ${el.status}`);
    if (el.status === "retired") continue;
    for (const e of checkContent(el)) errors.push(`${where}: ${e}`);
    for (const e of refErrors(el, onto)) errors.push(`${where}: ${e}`);
    const quotes = (el.evidence || []).filter((ev) => ev.type === "quote");
    const exps = (el.evidence || []).filter((ev) => ev.type === "experiment");
    if (quotes.length === 0) errors.push(`${where}: no quoted evidence`);
    if (el.support !== supportOf(el)) errors.push(`${where}: support ${el.support} but evidence gives ${supportOf(el)}`);
    if (isPolicy(el.kind)) {
      if (el.status === "active" && exps.length === 0)
        errors.push(`${where}: active policy without a confirming experiment`);
    } else if (el.status !== "active") errors.push(`${where}: structure is active or retired`);
    if (work) {
      const reps = readJsonl(path.join(work, "replications.jsonl"));
      for (const ev of (el.evidence || []).filter((x) => x.type === "replication")) {
        const found = reps.some((r) => r.elements.some((e) => e.id === el.id && e.tasks[ev.task]?.outcome === "gain"));
        if (!found) errors.push(`${where}: no replication record shows a gain in ${ev.task}`);
      }
    }
    if (experiments) {
      for (const ev of exps) {
        const x = experiments.get(ev.id);
        if (!x) errors.push(`${where}: ${ev.id} is not in experiments.jsonl`);
        else if (x.outcome !== "confirmed" || !x.tests.includes(el.id) || x.task !== ev.task)
          errors.push(`${where}: ${ev.id} does not confirm it`);
      }
    }
    if (corpus.sessions.size === 0) continue;
    for (const ev of quotes) {
      const err = checkQuote(corpus, ev);
      if (err) errors.push(`${where}: ${err}`);
    }
    const hits = forbiddenIn(el, corpus.forbidden);
    if (hits.length) errors.push(`${where}: instance ids in content: ${hits.join(", ")}`);
  }
  if (corpus.sessions.size === 0) warnings.push("no corpus given: quotes and instance ids were not checked");
  if (!experiments) warnings.push("no work directory given: experiment evidence was not checked");

  const view = render(onto);
  const tokens = estimateTokens(view);
  if (tokens > onto.budget_tokens)
    errors.push(`rendered view is ${tokens} tokens, over the budget of ${onto.budget_tokens}`);
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

const EXPORTED = new Set(["SKILL.md", "ONTOLOGY.md", "ontology.json"]);

/**
 * The deployable copy. The destination holds exactly what the slot produces: any other file in it
 * is removed, so nothing written beside the export can reach the Target. A destination with a
 * subfolder is refused rather than emptied.
 */
export function exportSlot(slot, dest) {
  const { onto } = loadSlot(slot);
  fs.mkdirSync(dest, { recursive: true });
  const removed = [];
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (EXPORTED.has(entry.name) || entry.name === ".keep") continue;
    if (!entry.isFile()) throw new Error(`${dest} holds ${entry.name}, which is not a file the export writes; refusing to export there`);
    fs.rmSync(path.join(dest, entry.name));
    removed.push(entry.name);
  }
  const lean = {
    format: onto.format,
    version: onto.version,
    budget_tokens: onto.budget_tokens,
    elements: onto.elements
      .filter((e) => e.status === "active")
      .map((e) => {
        const { evidence, counterexamples, created, updated, merged_into, retired_reason, ...rest } = e;
        return rest;
      }),
  };
  fs.copyFileSync(path.join(slot, "SKILL.md"), path.join(dest, "SKILL.md"));
  fs.copyFileSync(path.join(slot, "ONTOLOGY.md"), path.join(dest, "ONTOLOGY.md"));
  fs.writeFileSync(path.join(dest, "ontology.json"), `${JSON.stringify(lean, null, 2)}\n`);
  return { version: onto.version, elements: lean.elements.length, ...(removed.length ? { removed } : {}) };
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

export function writeCorpus(outDir, rec) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${safeName(rec.session)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------------------------------------
// Diff, stats and the run summary

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
    else if (canonical(contentOf(ea)) !== canonical(contentOf(eb)) || ea.scope !== eb.scope) out.changed.push(id);
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

/** What the run did, computed from its records, not written by hand. */
export function summarize(slot, work) {
  const phases = {};
  for (const r of readJsonl(path.join(work, "records.jsonl"))) {
    if (r.kind !== "attempt") continue;
    phases[r.phase] ??= {};
    phases[r.phase][r.task] = r.score; // the last attempt of a task in a phase
  }
  const mean = (o) => {
    const v = Object.values(o);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
  };
  const exps = readJsonl(path.join(work, "experiments.jsonl"));
  const outcomes = {};
  for (const x of exps) outcomes[x.outcome] = (outcomes[x.outcome] || 0) + 1;
  const { onto } = loadSlot(slot);
  return {
    phase_scores: phases,
    phase_means: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, mean(v)])),
    experiments: { total: exps.length, ...outcomes },
    refuted_before_deployment: onto.elements
      .filter((e) => /^refuted by /.test(e.retired_reason || ""))
      .map((e) => e.id),
    replication: Object.fromEntries(
      (readJsonl(path.join(work, "replications.jsonl")).at(-1)?.elements || []).map((e) => [e.id, e.result]),
    ),
    judge_calls: judgeCalls(work),
    ontology: stats(onto),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI

const HELP = `onto.mjs: deterministic tools of the Ontology RSI Toolkit (Node built-ins only)

Slot
  init <slot> [--agents-md <AGENTS.md>] [--budget <tokens>]
      Create an empty learning slot; append the fixed reader line to AGENTS.md when given.
  apply <slot> <edits.json> --corpus <dir> [--work <dir>] [--snapshots <dir>] [--dry-run]
      Apply typed edits (ADD REFINE RETIRE MERGE); publish what passes.
  validate <slot> [--corpus <dir>] [--work <dir>]   Check every invariant. Exit 1 on an error.
  render <slot>                         Rewrite ONTOLOGY.md from ontology.json.
  export <slot> <dest>                  Write the deployable copy: active elements, no provenance.
  diff <a.json> <b.json>                Added, retired, promoted and changed ids.
  stats <slot>                          Counts per kind and status, and the token estimate.

Observation
  extract (--trace <file>... | --session <id> --agent-dir <agent dir>) --task <label> --out <corpus dir>
          [--used <ontology-used.txt>] [--log <file>] [--clip <chars>]
      Pull one Session's input and tool outputs into the corpus; save or print the condensed log.
      Use --task probe for your own read-only probes.

Experiment (each needs --config <file with the judge settings> and --work <dir>)
  judge --task <id> --answer <file> [--phase <name> --session <id>]
      Score an answer. With --phase it is recorded as that task's attempt in that phase.
  localize --task <id> --answer <file>
      Remove one answer field at a time and judge again: which fields earn credit, which do not.
  gaps --work <dir>
      Fields without credit across tasks, most widespread first.
  experiment <slot> --task <id> --base <file> --variant <file>
             [--tests <element id>... --predict better|worse] [--note <text>] [--snapshots <dir>]
      Judge two answers that differ only in fields the tested elements decide. The prediction is
      fixed here, before the judge is asked. Confirmed: the elements become active. Refuted: a
      single tested element is retired. Without --tests it only compares.
  replicate <slot> [--from baseline] [--to verify] [--snapshots <dir>]
      Compare, field by field, each task's attempt made before the ontology with the one a fresh
      Actor made reading it. A rule whose fields gained credit is marked reproduced; one whose
      fields lost credit is retired; one that moved nothing anywhere goes back to hypothesis.
  finish <slot> --work <dir> --corpus <dir> --skill <dest> --answers <dest>
      Validate, export the slot, copy each task's last attempt as its final answer, write the
      summary. Safe to run more than once.
  summary <slot> --work <dir>           Phase means, experiments, replication, judge calls, counts.

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

const PHASES = new Set(["baseline", "verify"]);
const list = (v) => (v === undefined || v === true ? [] : Array.isArray(v) ? v : [v]);
const print = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

export async function main(argv, hooks = {}) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  const str = (k) => (typeof flags[k] === "string" ? flags[k] : undefined);
  const need = (k) => {
    if (str(k) === undefined) throw new Error(`${cmd} needs --${k}`);
    return str(k);
  };
  // One run, one work directory: when the configuration names one, every command must use it.
  if (str("config") && str("work")) {
    const named = readJson(str("config"))?.paths?.work;
    if (named && path.resolve(named) !== path.resolve(str("work")))
      throw new Error(`--work ${str("work")} is not the run's work directory ${named} (training-request.json, paths.work)`);
  }
  const record = (rec) => {
    if (str("work")) appendJsonl(path.join(str("work"), "records.jsonl"), { time: new Date().toISOString(), ...rec });
  };
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  switch (cmd) {
    case "init": {
      if (!pos[0]) throw new Error("init needs <slot>");
      initSlot(pos[0], {
        agentsMd: str("agents-md"),
        budget: flags.budget ? Number(flags.budget) : undefined,
        date: str("date"),
      });
      print({ ok: true, slot: pos[0] });
      return 0;
    }
    case "extract": {
      const task = need("task");
      const out = need("out");
      let files = list(flags.trace);
      const session = str("session");
      if (files.length === 0) {
        if (!session || !str("agent-dir")) throw new Error("extract needs --trace or --session with --agent-dir");
        files = traceFiles(str("agent-dir"), session);
        if (files.length === 0) throw new Error(`no Trace files for session ${session}`);
      }
      const x = extractTrace(files, { session, clip: flags.clip ? Number(flags.clip) : 1500 });
      const rec = {
        session: x.session,
        task,
        kind: "trace",
        files,
        used: readUsed(str("used")),
        instance_ids: x.instance_ids,
        subject_ids: task === PROBE_TASK ? [] : x.subject_ids,
        sources: x.sources,
      };
      const file = writeCorpus(out, rec);
      const logText = `${x.log.join("\n")}\n`;
      if (str("log")) fs.writeFileSync(str("log"), logText);
      print({
        ok: true,
        session: rec.session,
        task,
        corpus_file: file,
        sources: rec.sources.length,
        used: rec.used,
        instance_ids: rec.instance_ids.length,
        subject_ids: rec.subject_ids,
        log: str("log") ?? logText,
      });
      return 0;
    }
    case "apply": {
      const [slot, editsFile] = pos;
      if (!slot || !editsFile) throw new Error("apply needs <slot> <edits.json>");
      const r = applyEdits(slot, readJson(editsFile), loadCorpus(need("corpus")), {
        snapshots: str("snapshots"),
        date: str("date"),
        dryRun: flags["dry-run"] === true,
      });
      record({
        kind: "apply",
        edits: editsFile,
        published: r.published,
        version: r.version,
        applied: r.applied.length,
        rejected: r.rejected,
      });
      print(r);
      return 0;
    }
    case "judge": {
      const work = need("work");
      const task = need("task");
      if (str("phase") !== undefined && !PHASES.has(str("phase")))
        throw new Error(`--phase must be baseline or verify; every attempt an Actor makes is recorded under one of them`);
      const r = await judgeAnswer(work, loadJudgeConfig(need("config")), task, readJson(need("answer")), hooks.ask);
      if (str("phase"))
        record({
          kind: "attempt",
          phase: str("phase"),
          task,
          session: str("session"),
          answer: str("answer"),
          answer_sha: r.answer_sha,
          score: r.score,
        });
      print({ task, score: r.score, cached: r.cached, answer_sha: r.answer_sha });
      return 0;
    }
    case "localize": {
      const work = need("work");
      const r = await localize(work, loadJudgeConfig(need("config")), need("task"), readJson(need("answer")), hooks.ask);
      record({ kind: "localize", task: r.task, answer_sha: r.answer_sha, score: r.score, no_credit: r.no_credit });
      print(r);
      return 0;
    }
    case "gaps": {
      print(gaps(need("work")));
      return 0;
    }
    case "experiment": {
      if (!pos[0]) throw new Error("experiment needs <slot>");
      const work = need("work");
      const r = await runExperiment(
        pos[0],
        work,
        loadJudgeConfig(need("config")),
        {
          task: need("task"),
          base: readJson(need("base")),
          variant: readJson(need("variant")),
          tests: list(flags.tests),
          predict: str("predict"),
          note: str("note"),
        },
        { snapshots: str("snapshots"), date: str("date"), ask: hooks.ask },
      );
      record({
        kind: "experiment",
        id: r.id,
        task: r.task,
        tests: r.tests,
        outcome: r.outcome,
        delta: r.delta,
        version: r.version,
      });
      print(r);
      return 0;
    }
    case "replicate": {
      if (!pos[0]) throw new Error("replicate needs <slot>");
      const r = await replicate(pos[0], need("work"), loadJudgeConfig(need("config")), {
        from: str("from"),
        to: str("to"),
        snapshots: str("snapshots"),
        date: str("date"),
        ask: hooks.ask,
      });
      record({ kind: "replicate", from: r.from, to: r.to, version: r.version, results: Object.fromEntries(r.elements.map((e) => [e.id, e.result])) });
      print(r);
      return 0;
    }
    case "finish": {
      if (!pos[0]) throw new Error("finish needs <slot>");
      const r = finish(pos[0], need("work"), need("corpus"), need("skill"), need("answers"));
      record({ kind: "finish", ok: r.ok, version: r.exported?.version });
      print(r);
      return r.ok ? 0 : 1;
    }
    case "validate": {
      if (!pos[0]) throw new Error("validate needs <slot>");
      const r = validateSlot(pos[0], loadCorpus(str("corpus")), str("work"));
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
    case "summary": {
      if (!pos[0]) throw new Error("summary needs <slot>");
      const work = need("work");
      const s = summarize(pos[0], work);
      fs.writeFileSync(path.join(work, "summary.json"), `${JSON.stringify(s, null, 2)}\n`);
      print(s);
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}; see --help`);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`onto.mjs: ${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
