/** `workflow` — the project's workflows: script graphs of trigger nodes (what waits) and run nodes (what runs). */

import { readFileSync } from "node:fs";
import type { ApiClient } from "@shared/api";
import { DIM, GREEN, RESET } from "./colors";
import { readStdin } from "./input";
import { fail, findByTitle } from "./title-match";

export function printWorkflowHelp() {
  process.stderr.write(`
tfa-cli workflow — the project's workflows (the Workflows view on the board, in the app)

A workflow is a graph. Trigger nodes wait (time, timeout, watch, webhook, source, composer, human buttons);
run nodes run (an AI prompt, a shell command on a machine, an inbox builtin). Lines go from → to; "when"
names the outcome that takes a line (none = plain done). A todo is one run: it moves node to node,
staying in its board group. <workflow> is an id or a name (matched loosely).

Usage:
  tfa-cli workflow [query]                     List them: id, name, on/off, what starts them
  tfa-cli workflow get <workflow>              Print it as nodes and lines; --json = the JSON to edit and set back
  tfa-cli workflow set <file|->                Create (no "id") or replace one from that JSON
  tfa-cli workflow on|off <workflow>           Start / stop listening (on needs a starter, every node reachable)
  tfa-cli workflow rm <workflow>               Delete it (its todos stay where they are, out of any run)
  tfa-cli workflow start <todo-id|-> <workflow> [node]
                                               Start a todo as a run, at a starter (default: its composer trigger)
  tfa-cli todo workflow <todo-id|->            Where a todo stands in its run, the ways on from there
  tfa-cli todo next <todo-id|-> ["outcome"]    Finish its node: plain done, or along the line "outcome"

JSON shape (what get --json prints):
  { "id", "name", "on", "group"?,
    "nodes": [ { "id", "kind": "trigger", "title", "on": { "kind": "time", "expr": "weekdays@8:30" } },
               { "id", "kind": "run", "title", "script": { "kind": "ai", "prompt": "…" }, "inputs": [] },
               { "id", "kind": "trigger", "title", "on": { "kind": "human", "buttons": [{ "label": "OK" }, { "label": "Not OK", "outcome": "Not OK" }] } } ],
    "links": [ { "from", "to", "when"? } ] }
  Node "title" is the one sentence on the box ("Gábor checks it"); also "description", "who", "askBefore".

Examples:
  tfa-cli workflow get "számlák" --json > wf.json && $EDITOR wf.json && tfa-cli workflow set wf.json
  tfa-cli todo next - "Not OK"
`);
}

const on = (t: any): string => {
  switch (t.kind) {
    case "time": case "timeout": return `${t.kind} ${t.expr}`;
    case "watch": return `watch "${t.cmd}" on ${t.machine} every ${Math.round(t.everyMs / 60_000)}m`;
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

const starts = (w: any) => w.nodes.filter((n: any) => n.kind === "trigger" && !w.links.some((l: any) => l.to === n.id)).map((n: any) => on(n.on)).join(", ");

export async function workflowCommand(api: ApiClient, positionals: string[], args: Record<string, any>, projectId: string | undefined, resolveTodo: (id: string) => Promise<string>) {
  if (!projectId) fail("No project — pass --project <id> or set TODOFORAI_PROJECT_ID");
  const [, verb, target, ...rest] = positionals;
  const all: any[] = await api.listWorkflows(projectId!);
  const find = (q: string | undefined, exact = false) => (q ? findByTitle(all, q, (w) => w.name, exact, "workflow") : fail(`Usage: tfa-cli workflow ${verb} <workflow>`));
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
    const w = find(target, true);
    await api.deleteWorkflow(projectId!, w.id);
    process.stderr.write(`${GREEN}✅ workflow "${w.name}" deleted${RESET}\n`);
    return;
  }
  if (verb === "start") {
    const [which, node] = rest;
    if (!target || !which) fail("Usage: tfa-cli workflow start <todo-id|-> <workflow> [node]");
    const w = find(which);
    await api.workflowStart(await resolveTodo(target), w.id, node);
    process.stderr.write(`${GREEN}✅ started in "${w.name}"${node ? ` at ${node}` : ""}${RESET}\n`);
    return;
  }
  const query = positionals.slice(verb === "list" ? 2 : 1).join(" ");
  const shown = query ? [findByTitle(all, query, (w) => w.name, false, "workflow")] : all;
  if (args.json) { json(shown); return; }
  for (const w of shown) console.log(`${w.id}  ${w.name}  ${DIM}${w.on ? "on" : "off"}${starts(w) ? ` · ${starts(w)}` : ""}${RESET}`);
  if (!shown.length) process.stderr.write(`${DIM}No workflows yet: tfa-cli workflow set <file|-> (see --help)${RESET}\n`);
}
