/** `workflow` — the project's workflows: script graphs of trigger nodes (what waits) and run nodes (what runs). */

import { readFileSync } from "node:fs";
import { WORKFLOW_FEED_MACHINE } from "@shared/fbe";
import type { ApiClient } from "@shared/api";
import { DIM, GREEN, RESET } from "./colors";
import { readStdin } from "./input";
import { fail, findExact } from "./title-match";

export function printWorkflowHelp() {
  process.stderr.write(`
tfa-cli workflow — the project's workflows (the Workflows view on the board, in the app)

A workflow is a graph. Trigger nodes wait (time, timeout, watch, webhook, source, composer, human buttons);
run nodes run (an AI prompt, a shell command on a machine, an inbox builtin). Lines go from → to; "when"
names the outcome that takes a line (none = plain done). A todo is one run: it moves node to node,
staying in its board group. <workflow> and <step> are an id or the exact name (case aside); a near
miss is refused with what it may have meant.

Usage:
  tfa-cli workflow [query]                     List them: id, name, on/off, what starts them
  tfa-cli workflow get <workflow>              Print it as nodes and lines; --json = the JSON to edit and set back
  tfa-cli workflow set <file|->                Create (no "id") or replace one from that JSON
  tfa-cli workflow on|off <workflow>           Start / stop listening (on needs a starter, every node reachable)
  tfa-cli workflow rm <workflow>               Delete it (its todos stay where they are, out of any run)

A run is the todo itself, so runs are handled as todos:
  tfa-cli list --workflow <workflow> [--node <step>]   Its runs (at that step)
  tfa-cli todo set <todo-id|-> workflow="<workflow>"   Start it at the composer starter
  tfa-cli todo set <todo-id|-> workflow="<workflow>:<step>"
                                               Put it at any step: a box runs again (a retry), a person is asked again
  tfa-cli todo set <todo-id|-> workflow=""     Take it out of its workflow (the todo stays)
  tfa-cli todo workflow <todo-id|->            Its path: each step with what came in and what it gave on
  tfa-cli todo next <todo-id|-> ["outcome"]    Finish its node: plain done, or along the line "outcome"
                                               (refused while its shell box still runs)

What a box gets and gives (its input = what the step before gave on):
  ai     the input as its message, input files attached; gives its last answer and that answer's files
  shell  runs on "machine" in its own dir: input text on stdin, input files in $TFA_IN; gives its
         stdout and the files it writes to $OUT; exit 0 = plain line, else the "failed" line; 10 min max
  human  waits for one of its buttons (in the app, or todo next); passes its input on unchanged
  time / timeout / watch / webhook   wait; a fire's payload is the next box's input
A run that stopped (server restart, machine offline, lost result) is marked "Stuck: …" in its chat
with when, and asks for review: put it back at that step (todo set … workflow="<workflow>:<step>").

JSON shape (what get --json prints):
  { "id", "name", "on", "group"?,
    "nodes": [ { "id", "kind": "trigger", "title", "on": { "kind": "time", "expr": "weekdays@8:30" } },
               { "id", "kind": "run", "title", "script": { "kind": "ai", "prompt": "…" } },
               { "id", "kind": "trigger", "title", "on": { "kind": "human", "buttons": [{ "label": "OK" }, { "label": "Not OK", "outcome": "Not OK" }] } } ],
    "links": [ { "from", "to", "when"? } ] }
  Node "title" is the one sentence on the box ("Gábor checks it"); also "description", "who", "askBefore".

Common 1-step patterns (standing automations, crons, watches, RSS feeds and group feeds are all workflows):
  • Act on each item (AI run): connect the trigger to a { "id": "work", "kind": "run", "title": "…", "script": { "kind": "ai", "prompt": "…" } } node.
  • File & triage into a board group: set top-level "group": "<slug>" and connect the trigger to triage (builtin: "triage", mode: "d3") → merge (builtin: "merge", mode: "d3").
  • Watch trigger: "on": { "kind": "watch", "expr": "<word>", "cmd": "<check>", "machine": "<your deviceId from tfa-device --json>", "everyMs": 300000 }
    ("expr" must hold the single word the watch feeds; for RSS/Atom/JSON feed URLs, set "machine": "engine" and "cmd": "https://…/feed.xml").
  • Copyable 1-step recurring workflow JSON:
    { "name": "Weekly SEO snapshot", "on": true, "group": "marketing",
      "nodes": [
        { "id": "start", "kind": "trigger", "title": "Every Monday 08:00", "on": { "kind": "time", "expr": "mon@8:00", "timeZone": "Europe/Budapest" } },
        { "id": "work", "kind": "run", "title": "Run SEO check", "script": { "kind": "ai", "prompt": "Run track.sh and update the SEO notes." } }
      ],
      "links": [{ "from": "start", "to": "work" }] }

Examples:
  tfa-cli workflow get "számlák" --json > wf.json && $EDITOR wf.json && tfa-cli workflow set wf.json
  tfa-cli todo next - "Not OK"
`);
}

const on = (t: any): string => {
  switch (t.kind) {
    case "time": case "timeout": return `${t.kind} ${t.expr}`;
    case "watch": return `watch "${t.cmd}" ${t.machine === WORKFLOW_FEED_MACHINE ? "(feed)" : `on ${t.machine}`} every ${Math.round(t.everyMs / 60_000)}m`;
    case "webhook": return `webhook${t.key ? ` ${t.key}` : ""}`;
    case "source": return `source ${t.source}`;
    case "human": return `human ${t.buttons.map((b: any) => `[${b.label}]`).join(" ")}`;
    default: return t.kind;
  }
};
const script = (s: any): string =>
  s.kind === "ai" ? `ai "${s.prompt.split("\n")[0].slice(0, 80)}"` : s.kind === "shell" ? `shell "${s.cmd.split("\n")[0].slice(0, 80)}" on ${s.machine}` : `${s.builtin} ${s.mode}`;

/** A workflow as text: each node (⚡ waits, ▶ runs) with the lines out of it. */
export function workflowText(w: any, names: (id: string) => string | undefined = () => undefined): string {
  const title = (id: string) => (id.startsWith("wf:") ? `workflow "${names(id.slice(3)) ?? id.slice(3)}"` : id);
  const out = [`${w.name}  ${DIM}${w.on ? "on" : "off"}${w.group ? `, into ${w.group}` : ""}  (${w.id})${RESET}`];
  for (const n of w.nodes) {
    out.push(`  ${n.kind === "trigger" ? "⚡" : "▶"} ${n.id}  ${n.title}  ${DIM}${n.kind === "trigger" ? on(n.on) : script(n.script)}${RESET}`);
    for (const l of w.links.filter((x: any) => x.from === n.id)) out.push(`      → ${title(l.to)}${l.when ? `  ${DIM}(${l.when})${RESET}` : ""}`);
  }
  return out.join("\n");
}

/** A step of `w` by its id or exact title. */
export const findStep = (w: any, q: string) => findExact(w.nodes as any[], q, (n) => n.title, `step of "${w.name}"`);

/** "<workflow>" or "<workflow>:<step>", each its id or exact name. A name may hold ":" itself:
 *  the whole as a name first, then the one split where both sides name something exactly. */
export function findWorkflowStep(all: any[], spec: string): { w: any; node?: any } {
  // As findExact reads a name: an id first, else the titles as written.
  const named = <T extends { id: string }>(xs: T[], q: string, titleOf: (x: T) => string) => {
    const byId = xs.filter((x) => x.id === q.trim());
    return byId.length ? byId : xs.filter((x) => titleOf(x).trim().toLowerCase() === q.trim().toLowerCase());
  };
  const workflows = (q: string) => named(all, q, (x) => x.name);
  if (workflows(spec).length) return { w: findExact(all, spec, (x) => x.name, "workflow") };
  const readings: { w: any; node: any }[] = [];
  for (let i = spec.indexOf(":"); i > 0; i = spec.indexOf(":", i + 1)) {
    const [w, more] = workflows(spec.slice(0, i));
    const step = spec.slice(i + 1);
    // A step both sides name: findStep, so two steps of that title fail listing their ids.
    if (w && !more && step.trim() && named(w.nodes as any[], step, (n) => n.title).length) readings.push({ w, node: findStep(w, step.trim()) });
  }
  if (readings.length > 1) fail(`"${spec}" reads more ways: ${readings.map((r) => `"${r.w.name}" at "${r.node.title}"`).join(", ")}. Use the ids: <workflow-id>:<step-id>`);
  if (readings.length) return readings[0];
  // Nothing exact: the workflow part names one, its step does not (it fails listing its steps), else the whole fails.
  const i = spec.lastIndexOf(":");
  const [w, more] = i > 0 ? workflows(spec.slice(0, i)) : [];
  if (w && !more) return { w, node: findStep(w, spec.slice(i + 1).trim()) };
  return { w: findExact(all, spec, (x) => x.name, "workflow") };
}

/** What went along a line: its text's first line and its files ("nothing": an empty output). */
const io = (o: any) => {
  const text = String(o.text ?? "").trim(), first = text.split("\n")[0].slice(0, 100);
  const files = (o.files ?? []).map((f: any) => f.originalName ?? f.id);
  return [text && `"${first}${first.length < text.length ? "…" : ""}"`, files.length && `files: ${files.join(", ")}`].filter(Boolean).join(", ") || "nothing";
};

/** A run (`todo workflow`): its path, each step with what came in and what it gave on, and the ways on. */
export function positionText(pos: any, wfName: (id: string) => string = (id) => id): string {
  const out = [`${pos.workflowName}${pos.node ? "" : `  ${DIM}(ended)${RESET}`}`];
  for (const s of pos.steps) {
    if (s.state === "next") { out.push(`    ${DIM}${s.title}  (ahead)${RESET}`); continue; }
    const when = s.at ? `${new Date(s.at).toISOString().slice(0, 16).replace("T", " ")}  ` : "";
    out.push(`  ${s.state === "here" ? "▶" : "✓"} ${s.title}${s.outcome ? `  (${s.outcome})` : ""}  ${DIM}${when}${s.node}${RESET}`);
    if (s.state === "here") out.push(`      in:  ${s.input ? io(s.input) : "nothing"}`);
    else if (s.out) out.push(`      out: ${io(s.out)}`);
  }
  for (const m of pos.moves) out.push(`  ${m.label ? `[${m.label}]` : m.when ? `"${m.when}"` : "done"} → ${m.toTitle ?? "end"}${m.toWorkflow ? `, on in the workflow "${wfName(m.toWorkflow)}"` : ""}${m.to ? ` ${DIM}(${m.to})${RESET}` : ""}`);
  if (pos.pending !== undefined) out.push(`${DIM}picked: ${pos.pending || "done"} (goes when the agent run ends)${RESET}`);
  return out.join("\n");
}

const starts = (w: any) => w.nodes.filter((n: any) => n.kind === "trigger" && !w.links.some((l: any) => l.to === n.id)).map((n: any) => on(n.on)).join(", ");

export async function workflowCommand(api: ApiClient, positionals: string[], args: Record<string, any>, projectId: string | undefined) {
  if (!projectId) fail("No project — pass --project <id> or set TODOFORAI_PROJECT_ID");
  const [, verb, target] = positionals;
  const all: any[] = await api.listWorkflows(projectId!);
  const find = (q: string | undefined) => (q ? findExact(all, q, (w) => w.name, "workflow") : fail(`Usage: tfa-cli workflow ${verb} <workflow>`));
  const names = (id: string) => all.find((w) => w.id === id)?.name;
  const json = (x: unknown) => console.log(JSON.stringify(x, null, 2));

  if (verb === "get") {
    const w = find(target);
    if (args.json) { const { updatedAt: _a, updatedBy: _b, ...edit } = w; json(edit); return; }
    console.log(workflowText(w, names));
    return;
  }
  if (verb === "set") {
    if (!target) fail("Usage: tfa-cli workflow set <file|->");
    let input: any;
    try { input = JSON.parse(target === "-" ? await readStdin() : readFileSync(target, "utf8")); } catch (e: any) { fail(`Not a workflow JSON: ${e.message}`); }
    const { updatedAt: _a, updatedBy: _b, generation: _g, projectId: _p, ...w } = input;
    const saved = await api.setWorkflow(projectId!, w);
    if (args.json) { json(saved); return; }
    process.stderr.write(`${GREEN}✅ workflow "${saved.name}" ${w.id ? "saved" : "created"}${RESET}\n`);
    console.log(workflowText(saved, names));
    return;
  }
  if (verb === "on" || verb === "off") {
    const { updatedAt: _a, updatedBy: _b, ...w } = find(target);
    const saved = await api.setWorkflow(projectId!, { ...w, on: verb === "on" });
    if (args.json) { json(saved); return; }
    process.stderr.write(`${GREEN}✅ workflow "${saved.name}" ${verb}${RESET}\n`);
    return;
  }
  if (verb === "rm") {
    const w = find(target);
    await api.deleteWorkflow(projectId!, w.id);
    process.stderr.write(`${GREEN}✅ workflow "${w.name}" deleted${RESET}\n`);
    return;
  }
  if (verb === "start") fail('A run is the todo: tfa-cli todo set <todo-id|-> workflow="<workflow>[:<step>]"');
  const query = positionals.slice(verb === "list" ? 2 : 1).join(" ");
  // A listing filters: every workflow whose name holds the words.
  const shown = query ? all.filter((w) => w.id === query || w.name.toLowerCase().includes(query.toLowerCase())) : all;
  if (args.json) { json(shown); return; }
  for (const w of shown) console.log(`${w.id}  ${w.name}  ${DIM}${w.on ? "on" : "off"}${starts(w) ? ` · ${starts(w)}` : ""}${RESET}`);
  if (!shown.length) process.stderr.write(`${DIM}No workflows yet: tfa-cli workflow set <file|-> (see --help)${RESET}\n`);
}
