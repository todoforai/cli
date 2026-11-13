/** `todo` and `project` subcommands — field-level edits of a todo / project via field=value. */

import type { ApiClient, VoiceScope } from "@shared/api";
import { parseAssignments, resolveAgent } from "./agent-command";
import { getEnv } from "./args";
import { getDisplayName, getItemId } from "./select";
import { DIM, GREEN, RED, RESET } from "./colors";
import { ADAPTERS, DEVICE_CHANNELS, checkChannel, collectChannel } from "./voice-collect";
import { readFileSync } from "fs";
import { randomUUID } from "node:crypto";
import { readStdin } from "./input";
import { MANUAL_CHANNEL, NEVER_SCHEDULED_TIMESTAMP, manualAnswersOf, manualSamples, voiceNamesOf } from "@shared/fbe";

export function printTodoHelp() {
  process.stderr.write(`
tfa-cli todo — edit a todo's fields

Usage:
  tfa-cli todo set <todo-id|-> <field=value>…   Update fields ("-" = $TODOFORAI_TODO_ID)
  tfa-cli todo comment <todo-id|-> "text"       Comment on it: why it's on the board, where it
                                                stands (whoever sees the todo reads it, the agent never does)
  tfa-cli todo comments <todo-id|->             List its comments
  tfa-cli todo html <todo-id|-> [file|-]        Its row HTML: no file = print it; a file / - (stdin)
                                                = replace it; --rm = remove it (see below)
  tfa-cli todo restore <todo-id>                Bring a trashed todo back (undo of 'delete')
  tfa-cli todo workflow <todo-id|->             Where it stands in its workflow run, the ways on from here
  tfa-cli todo next <todo-id|-> ["outcome"]     Finish its node: plain done, or along the line named
                                                "outcome"; during its own agent run: when that ends

Fields (PUT /todos/{id}):
  title            first-line content (alias: content)
  group            group slug; "" makes it ungrouped (alias: groupTag)
  star             true|false (starredAt now / 0)
  schedule         when its queued first message runs: "YYYY-MM-DD HH:MM" (local), +30m/+2h/+1d,
                   unix ms; now (= start-now, also 0) runs it; none|draft parks it unstarted
  agent            agentSettingsId (alias: agentSettingsId)
  public           true|false — refused from an agent shell (isPublic)
  kind             task|info — promote an ⓘ info row to a task (or back)
  section          one of its group's sections (project groups set <slug> sections=…); "" takes it out
  state            one of the project's own states (project states); also sets its base status; "" clears
  deadline         YYYY-MM-DD (whole day) or "YYYY-MM-DD HH:MM" (local time); "" clears (alias: end)
  start            YYYY-MM-DD planned start; "" clears
  parent           parent todo id (same project; not itself or one of its subtodos); "" detaches (alias: parentTodoId)
  assignee         one project member, by email or user id (project members); "" unassigns (alias: assigneeId)

  tfa-cli todo message <todo-id|-> <message-id> <field=value>…
                   Edit a SCHEDULED (not yet run) message: content, schedule (unix ms;
                   0 = run now). Runs with the todo's own agent.

Row HTML (todo html): a bare HTML fragment drawn live INSIDE the todo's board row, under its title
  (and pinned under the title bar of its open chat, there full chat width) —
  the html_snippet harness: theme tokens, styled bare <button>/<input>, todo.exec/chat/connect/show.
  Space: the row's width (~300-360px on desktop, full width on a phone) minus a 34px left indent,
  at most 160px tall (clipped below); transparent on the row. Keep it to one line of chips/buttons,
  a progress bar, a mini stat. todo.chat posts into THAT todo (starts a run with its agent).
  Read it back (no file) and rewrite it to update; it stays until replaced or removed.

Examples:
  tfa-cli todo set - title="Ship v2 landing" group=marketing
  tfa-cli todo set 3f2a91 star=true
  tfa-cli todo set 3f2a91 section="To pay"        (one of its group's sections; section="" takes it out)
  tfa-cli todo set - deadline=2026-11-20 start="2026-11-10 09:00"
  tfa-cli todo set 3f2a91 parent=52614dd2 assignee=gabor@example.com
  tfa-cli todo comment - "Asked by Gábor; waits for the Q3 numbers"
  tfa-cli todo message - 8c1d… schedule=1760000000000
  tfa-cli status <todo-id> DONE                  (status has its own command)
`);
}

export function printProjectHelp() {
  process.stderr.write(`
tfa-cli project — edit the current project

--project <id>, $TODOFORAI_PROJECT_ID, or the configured default selects the project.

Usage:
  tfa-cli project list                             Projects you can access (* = default)
  tfa-cli project members                          Who is on it (notify --to <email> reaches them)
  tfa-cli project set <field=value>…               name=… description=… logo=<https image url|"">
                                                    (isPublic refused from an agent shell)
  tfa-cli project default                          Make it the project you land on at /
  tfa-cli project agent <agent>                    Default agent for new todos in this project
  tfa-cli project settings <field=value>…          Project settings (PUT /settings/projects/{id})
  tfa-cli project groups                           List todo groups
  tfa-cli project groups set <slug> <field=value>… Create/update a group: name description pinned archived order
                                                   sections="Urgent,To pay,Later" (its piles, in order; "" = none)
  tfa-cli project groups section <slug> <old> <new>
                                                   Rename a section; its todos keep it
  tfa-cli project groups intake <slug> [on|off|regenerate] [field=value]…
                                                   Public intake: autoStart maxSubmissions postIpLimit placeholder agentSettingsId
  tfa-cli project groups reorder <slug>…           Set wall order
  tfa-cli project states                           The project's own todo states (name + lucide icon on a base status)
  tfa-cli project states set <slug> <field=value>… Create/update one: name icon (lucide.dev/icons name, e.g. thumbs-down)
                                                   color (#rrggbb, "" = the base status' color)
                                                   base (READY|REVIEW_REQUESTED|DONE|CANCELLED|REJECTED)
  tfa-cli project states drop <slug>               Remove one (todos in it fall back to their status)
  (workflows: tfa-cli workflow --help)
  tfa-cli project sources                          What brings items in from outside besides tfa-wait triggers:
                                                   your linked accounts (Slack, Discord, X, Instagram, Reddit)
                                                   and the project's public forms, each with the workflow
                                                   or group it fills ("sources all": your accounts in any project)
  tfa-cli project sources set <platform|id> workflow="<name>" | group=<slug>
                                                   Point a linked account at a workflow (its items start
                                                   runs at its source trigger) or at a group
  tfa-cli project surfaces                         List the board's cards you can see: id, title, ref|note, group, color
  tfa-cli project surfaces set <id> ref=<ref> [title=…] [group=<slug>] [color=#hex] [order=N]
                                                   Show a ref on the board: a todo id, <todoId>:<alias>
                                                   (a show) or an http(s) url. group= puts it
                                                   inside that group's card; group="" makes it standalone.
  tfa-cli project surfaces set <id> body="…" [group=<slug>] [color=#hex]
                                                   A note (markdown text). Seen by
                                                   whoever sees where it sits: standalone = the project,
                                                   group = its members, your My Private group = only you.
                                                   Read/append/edit notes by title: tfa-cli notes help
                                                   Widgets (ref cards) by title, read/update their show: tfa-cli widgets help
  tfa-cli project surfaces rm <id>                 Take it off the board

Examples:
  tfa-cli project set name="Q4 launch"
  tfa-cli project groups set marketing name=Marketing description="Top-of-funnel work"
  tfa-cli project groups reorder marketing sales ops
  tfa-cli project surfaces set weekly-kpis ref=$TODOFORAI_TODO_ID:kpi title="Weekly KPIs" group=marketing
  tfa-cli project surfaces set sales-rules body="Quote prices in EUR, net of VAT." group=sales
`);
}

const TODO_ALIASES: Record<string, string> = {
  title: "content",
  group: "groupTag",
  schedule: "scheduledTimestamp",
  agent: "agentSettingsId",
  public: "isPublic",
  deadline: "endDate",
  end: "endDate",
  start: "startDate",
  parent: "parentTodoId",
  assignee: "assigneeId",
};

/** YYYY-MM-DD → its UTC midnight (a calendar day, the same for every timezone); "" / 0 clears. */
function parseDay(value: unknown, field: string): number {
  if (value === "" || value === 0) return 0;
  if (typeof value === "number") return value;
  const day = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) fail(`${field} must be YYYY-MM-DD`);
  return Date.parse(day);
}

/** Whole day, or a day + HH:MM in local time (an exact moment: timed). */
function parseMoment(value: unknown, field: string): [number, boolean] {
  const timed = typeof value === "string" && value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
  if (!timed) return [parseDay(value, field), false];
  const at = new Date(`${timed[1]}T${timed[2]}`).getTime();
  if (Number.isNaN(at)) fail(`${field} must be YYYY-MM-DD or "YYYY-MM-DD HH:MM"`);
  return [at, true];
}

const SCHEDULE_FORMATS = 'none|draft, now, +30m/+2h/+1d, "YYYY-MM-DD HH:MM" or unix ms';
const MAX_START_MS = 2 * 365 * 86_400_000; // the backend's limit (WaitService)
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A start time → unix ms, NEVER_SCHEDULED_TIMESTAMP (a draft, never started by itself) or "now". */
export function parseSchedule(value: unknown): number | "now" {
  if (value === "none" || value === "draft") return NEVER_SCHEDULED_TIMESTAMP;
  if (value === "now" || value === 0 || value === "0") return "now";
  const rel = String(value).match(/^\+(\d+)([mhd])$/);
  const [at, timed] = rel ? [Date.now() + Number(rel[1]) * UNIT_MS[rel[2]], true]
    : /^\d{10,}$/.test(String(value)) ? [Number(value), true]
    : /^\d{4}-/.test(String(value)) ? parseMoment(value, "schedule") : [0, false];
  if (!timed) fail(`schedule must be one of: ${SCHEDULE_FORMATS} (a bare day has no time)`);
  if (!(at < Date.now() + MAX_START_MS)) fail("schedule can be at most 2 years ahead (or none for a draft)");
  if (at < Date.now() - 60_000) fail(`schedule ${new Date(at).toLocaleString()} is in the past (use now to start it)`);
  return at;
}

/** Press Start on a todo's queued first message (a draft or a scheduled one): it runs now. */
export async function startNow(api: ApiClient, todoId: string) {
  const todo = await api.getTodo(todoId);
  if (todo.status !== "PAUSED" && todo.status !== "SCHEDULED") fail(`Nothing to start: ${todoId} is ${todo.status}, not a draft or scheduled todo`);
  await api.updateAndStart(todoId, todo.agentSettings || await api.getAgentSettings(todo.agentSettingsId));
}

const NO_PROJECT = "No project — pass --project <id> or set TODOFORAI_PROJECT_ID";

/** A member email → their user id, among the members of the todo's project. */
async function memberIdByEmail(api: ApiClient, todoId: string, email: string): Promise<string> {
  const { projectId } = await api.getTodo(todoId);
  const members: { id: string; email?: string }[] = await api.getProjectMembers(projectId);
  return members.find(m => m.email?.toLowerCase() === email.toLowerCase())?.id ?? fail(`No project member with email ${email} (tfa-cli project members)`);
}

function fail(msg: string): never {
  process.stderr.write(`${RED}${msg}${RESET}\n`);
  process.exit(2);
}

export async function todoCommand(api: ApiClient, positionals: string[], args: Record<string, any>) {
  const [, sub, idArg, ...rest] = positionals;
  if (sub === "restore") {
    if (!idArg) fail("Usage: tfa-cli todo restore <todo-id>");
    await api.restoreTodo(idArg);
    process.stderr.write(`${GREEN}✅ Restored ${idArg}${RESET}\n`);
    return;
  }
  const todoId = (!idArg || idArg === "-") ? getEnv("TODO_ID") : idArg;
  if (sub === "message") {
    const [messageId, ...fields] = rest;
    if (!todoId || !messageId || !fields.length) fail("Usage: tfa-cli todo message <todo-id|-> <message-id> <field=value>…");
    const updates = parseAssignments(fields, { schedule: "scheduledTimestamp" });
    // The scheduler runs the message with this agent: always the TARGET todo's own.
    const agentSettingsId = (await api.getTodo(todoId))?.agentSettingsId;
    if (!agentSettingsId) fail("Todo has no agent assigned");
    await api.updateScheduledMessage(todoId, messageId, agentSettingsId, updates);
    process.stderr.write(`${GREEN}✅ message ${messageId} updated: ${Object.keys(updates).join(", ")}${RESET}\n`);
    return;
  }
  if (sub === "comment") {
    const content = rest.join(" ").trim();
    if (!todoId || !content) fail('Usage: tfa-cli todo comment <todo-id|-> "text"');
    const comment = await api.addComment(todoId, content);
    if (args.json) { console.log(JSON.stringify(comment)); return; }
    process.stderr.write(`${GREEN}✅ commented on ${todoId}${RESET}
`);
    return;
  }
  if (sub === "html") {
    if (!todoId) fail("Usage: tfa-cli todo html <todo-id|-> [file|-] [--rm]");
    const src = rest[0];
    if (!src && !args.rm) {
      const row = await api.getRowHtml(todoId);
      if (args.json) { console.log(JSON.stringify(row)); return; }
      if (row) process.stdout.write(row.html.endsWith("\n") ? row.html : row.html + "\n");
      else process.stderr.write(`${DIM}No row HTML${RESET}\n`);
      return;
    }
    const html = args.rm ? "" : src === "-" ? await readStdin() : readFileSync(src, "utf8");
    if (!args.rm && !html.trim()) fail("Empty HTML (use --rm to remove it)");
    await api.setRowHtml(todoId, html);
    process.stderr.write(`${GREEN}✅ ${todoId} row HTML ${args.rm ? "removed" : `set (${html.length} chars)`}${RESET}\n`);
    return;
  }
  if (sub === "comments") {
    if (!todoId) fail("Usage: tfa-cli todo comments <todo-id|->");
    const { comments, authors } = await api.listComments(todoId);
    const own = comments.filter((c: any) => !c.messageId);
    if (args.json) { console.log(JSON.stringify(own, null, 2)); return; }
    const name = new Map(authors.map((a: any) => [a.id, a.name]));
    if (!own.length) process.stderr.write(`${DIM}No comments${RESET}\n`);
    for (const c of own) process.stderr.write(`${DIM}${new Date(c.createdAt).toISOString().slice(0, 16).replace("T", " ")} ${name.get(c.authorId) ?? c.authorId}${c.via === "agent" ? " (agent)" : ""}${RESET}  ${c.content}\n`);
    return;
  }
  if (sub === "next") {
    if (!todoId) fail('Usage: tfa-cli todo next <todo-id|-> ["outcome"]');
    const outcome = rest.join(" ").trim() || undefined;
    const r = await api.workflowNext(todoId, outcome);
    if (args.json) { console.log(JSON.stringify(r)); return; }
    const where = r.to !== undefined ? `on to ${r.toTitle ?? r.to}` : "done: the end of its run";
    process.stderr.write(`${GREEN}✅ ${r.pending ? `goes ${where} when this agent run ends` : where}${RESET}\n`);
    return;
  }
  if (sub === "workflow" || sub === "flow") {
    if (!todoId) fail("Usage: tfa-cli todo workflow <todo-id|->");
    const pos: any = await api.workflowPosition(todoId);
    if (args.json) { console.log(JSON.stringify(pos, null, 2)); return; }
    if (!pos) { process.stderr.write(`${DIM}Not in a workflow${RESET}\n`); return; }
    const mark: Record<string, string> = { done: "✓ ", here: "▶ ", next: "" };
    const others: any[] = pos.moves.some((m: any) => m.toWorkflow) ? await api.listWorkflows((await api.getTodo(todoId)).projectId) : [];
    const wfName = (id: string) => others.find((w) => w.id === id)?.name ?? id;
    process.stderr.write(`${pos.workflowName}: ${pos.steps.map((s: any) => `${mark[s.state]}${s.title}`).join(" › ")}${pos.node ? "" : `  ${DIM}(ended)${RESET}`}\n`);
    for (const m of pos.moves) process.stderr.write(`  ${m.label ? `[${m.label}]` : m.when ? `"${m.when}"` : "done"} → ${m.toTitle ?? "end"}${m.toWorkflow ? `, on in the workflow "${wfName(m.toWorkflow)}"` : ""}${m.to ? ` ${DIM}(${m.to})${RESET}` : ""}\n`);
    if (pos.pending !== undefined) process.stderr.write(`${DIM}picked: ${pos.pending || "done"} (goes when the agent run ends)${RESET}\n`);
    return;
  }
  if (sub !== "set") { printTodoHelp(); process.exit(sub ? 2 : 0); }
  if (!todoId || !rest.length) fail("Usage: tfa-cli todo set <todo-id|-> <field=value>…");
  const updates = parseAssignments(rest, TODO_ALIASES);
  if ("star" in updates) {
    if (typeof updates.star !== "boolean") fail("star must be true or false");
    updates.starredAt = updates.star ? Date.now() : 0;
    delete updates.star;
  }
  if ("startDate" in updates) [updates.startDate, updates.startTimed] = parseMoment(updates.startDate, "start");
  if ("endDate" in updates) [updates.endDate, updates.endTimed] = parseMoment(updates.endDate, "deadline");
  if (updates.parentTodoId) updates.parentTodoId = await api.resolveTodoId(String(updates.parentTodoId));
  if (typeof updates.assigneeId === "string" && updates.assigneeId.includes("@")) updates.assigneeId = await memberIdByEmail(api, todoId, updates.assigneeId);
  const now = "scheduledTimestamp" in updates && (updates.scheduledTimestamp = parseSchedule(updates.scheduledTimestamp)) === "now";
  if (now) delete updates.scheduledTimestamp;
  if (Object.keys(updates).length) await api.updateTodo(todoId, updates);
  if (now) await startNow(api, todoId);
  if (args.json) { console.log(JSON.stringify({ todoId, ...updates, ...(now && { started: true }) })); return; }
  process.stderr.write(`${GREEN}✅ ${todoId} updated: ${[...Object.keys(updates), ...(now ? ["started"] : [])].join(", ")}${RESET}\n`);
}

export async function projectCommand(api: ApiClient, positionals: string[], args: Record<string, any>, projectId?: string) {
  const [, sub, ...rest] = positionals;
  if (!sub) { printProjectHelp(); process.exit(0); }
  // `list` is the only project verb that needs no selected project.
  if (sub === "list" || sub === "ls") {
    const projects: any[] = await api.listProjects();
    if (args.json) { console.log(JSON.stringify(projects, null, 2)); return; }
    for (const p of projects) {
      const pr = p.project ?? p;
      process.stderr.write(`${pr.isDefault ? "*" : " "} ${pr.name ?? ""}  ${DIM}${pr.id}${RESET}\n`);
    }
    return;
  }
  if (!projectId) fail(NO_PROJECT);

  if (sub === "members") {
    const members: { id: string; name?: string; email?: string }[] = await api.getProjectMembers(projectId);
    if (args.json) { console.log(JSON.stringify(members, null, 2)); return; }
    for (const m of members) process.stderr.write(`  ${m.name ?? ""}  ${m.email ?? ""}  ${DIM}${m.id}${RESET}\n`);
    return;
  }
  if (sub === "set") {
    if (!rest.length) fail("Usage: tfa-cli project set <field=value>…");
    const updates = parseAssignments(rest);
    await api.updateProject(projectId, updates);
    process.stderr.write(`${GREEN}✅ project updated: ${Object.keys(updates).join(", ")}${RESET}\n`);
    return;
  }
  if (sub === "default") {
    await api.setDefaultProject(projectId);
    process.stderr.write(`${GREEN}✅ ${projectId} is now the default project${RESET}\n`);
    return;
  }
  if (sub === "agent") {
    if (!rest[0]) fail("Usage: tfa-cli project agent <agent>");
    const agent = resolveAgent(await api.listAgentSettings(), rest[0]);
    await api.setProjectDefaultAgent(projectId, getItemId(agent));
    process.stderr.write(`${GREEN}✅ default agent for ${projectId}: ${getDisplayName(agent)}${RESET}\n`);
    return;
  }
  if (sub === "settings") {
    if (!rest.length) fail("Usage: tfa-cli project settings <field=value>…");
    const settings = parseAssignments(rest);
    await api.updateProjectSettings(projectId, settings);
    process.stderr.write(`${GREEN}✅ project settings updated: ${Object.keys(settings).join(", ")}${RESET}\n`);
    return;
  }
  if (sub === "groups") {
    const [verb, ...gargs] = rest;
    if (!verb) {
      const groups = await api.listProjectGroups(projectId);
      if (args.json) { console.log(JSON.stringify(groups, null, 2)); return; }
      for (const g of groups) process.stderr.write(`${getItemId(g) || g.slug}  ${g.name ?? ""}  ${DIM}${[g.description, g.sections?.length && `[${g.sections.join(" | ")}]`].filter(Boolean).join("  ")}${RESET}\n`);
      return;
    }
    if (verb === "set") {
      const [slug, ...fields] = gargs;
      if (!slug) fail("Usage: tfa-cli project groups set <slug> <field=value>…");
      const updates = parseAssignments(fields);
      // "A,B,C" (or a JSON array): the sections, in order.
      if ("sections" in updates && !Array.isArray(updates.sections)) updates.sections = String(updates.sections).split(",").map((s) => s.trim()).filter(Boolean);
      const group = await api.upsertProjectGroup(projectId, slug, updates);
      if (args.json) { console.log(JSON.stringify(group, null, 2)); return; }
      process.stderr.write(`${GREEN}✅ group ${slug} saved${RESET}\n`);
      return;
    }
    if (verb === "section") {
      const [slug, from, to] = gargs;
      if (!slug || !from || !to) fail("Usage: tfa-cli project groups section <slug> <old> <new>");
      const sections: string[] = (await api.listProjectGroups(projectId)).find((g: any) => g.slug === slug)?.sections ?? [];
      const at = sections.findIndex((s) => s.toLowerCase() === from.toLowerCase());
      if (at < 0) fail(`No section "${from}" in ${slug}${sections.length ? `: ${sections.join(", ")}` : ""}`);
      const group = await api.upsertProjectGroup(projectId, slug, { sections: sections.map((s, i) => (i === at ? to : s)), renameSection: { from: sections[at], to } });
      if (args.json) { console.log(JSON.stringify(group, null, 2)); return; }
      process.stderr.write(`${GREEN}✅ ${sections[at]} → ${to}${RESET}\n`);
      return;
    }
    if (verb === "intake") {
      const [slug, ...options] = gargs;
      if (!slug) fail("Usage: tfa-cli project groups intake <slug> [on|off|regenerate] [field=value]…");
      const action = ["on", "off", "regenerate"].includes(options[0]) ? options.shift() : undefined;
      if (options.length && action === "regenerate") fail("regenerate does not accept settings");
      const fields = parseAssignments(options);
      const intake = action === "regenerate"
        ? await api.regenerateProjectGroupIntake(projectId, slug)
        : action || options.length
          ? await api.updateProjectGroupIntake(projectId, slug, { ...fields, ...(action && { enabled: action === "on" }) })
          : await api.getProjectGroupIntake(projectId, slug);
      if (args.json) { console.log(JSON.stringify(intake, null, 2)); return; }
      process.stderr.write(`${slug}: public ${intake.enabled ? "on" : "off"}, ${intake.submissionCount}/${intake.maxSubmissions}, autoStart=${intake.autoStart}\n`);
      if (intake.url) console.log(intake.url);
      return;
    }
    if (verb === "reorder") {
      if (!gargs.length) fail("Usage: tfa-cli project groups reorder <slug>…");
      await api.reorderProjectGroups(projectId, gargs);
      process.stderr.write(`${GREEN}✅ groups reordered${RESET}\n`);
      return;
    }
    fail(`Unknown 'project groups' verb: ${verb}`);
  }
  if (sub === "states") {
    const [verb, slug, ...fields] = rest;
    const states: any[] = await api.listTodoStates(projectId);
    if (!verb) {
      if (args.json) { console.log(JSON.stringify(states, null, 2)); return; }
      if (!states.length) process.stderr.write(`${DIM}No states yet: tfa-cli project states set <slug> name=… icon=… base=…${RESET}\n`);
      for (const st of states) process.stderr.write(`${st.slug}  ${st.name}  ${DIM}${st.icon}  ${st.base}${st.color ? `  ${st.color}` : ""}${RESET}\n`);
      return;
    }
    if (!slug) fail(`Usage: tfa-cli project states ${verb} <slug>${verb === "set" ? " <field=value>…" : ""}`);
    let next: any[];
    if (verb === "set") {
      const { name, icon, color, base, ...unknown } = parseAssignments(fields);
      if (Object.keys(unknown).length) fail(`Unknown field: ${Object.keys(unknown).join(", ")} (name, icon, color, base)`);
      const old = states.find((st) => st.slug === slug);
      const st = { slug, name: name ?? old?.name ?? slug, icon: icon ?? old?.icon ?? "tag", base: base ?? old?.base ?? "CANCELLED", ...((color ?? old?.color) && { color: color ?? old?.color }) };
      if (color === "") delete st.color;
      next = old ? states.map((s) => (s.slug === slug ? st : s)) : [...states, st];
    } else if (verb === "drop") {
      if (!states.some((st) => st.slug === slug)) fail(`No state "${slug}"`);
      next = states.filter((st) => st.slug !== slug);
    } else fail(`Unknown 'project states' verb: ${verb} (set, drop)`);
    const saved = await api.setTodoStates(projectId, next!);
    if (args.json) { console.log(JSON.stringify(saved, null, 2)); return; }
    process.stderr.write(`${GREEN}✅ state ${slug} ${verb === "drop" ? "removed" : "saved"}${RESET}\n`);
    return;
  }
  if (sub === "flows") fail("Flows are workflows now: tfa-cli workflow --help");
  if (sub === "sources") {
    const [verb, which, ...fields] = rest;
    const flows: any[] = await api.listWorkflows(projectId);
    if (!verb || verb === "all") {
      const sources: any[] = verb ? await api.listMySources() : await api.listSources(projectId);
      if (args.json) { console.log(JSON.stringify(sources, null, 2)); return; }
      for (const s of sources) {
        const flow = flows.find((f) => f.id === s.flow);
        const where = [s.projectId !== projectId && `project ${s.projectId}`, flow ? `workflow "${flow.name}"` : s.flow ? `workflow ${s.flow}` : `group ${s.group}`].filter(Boolean).join(", ");
        process.stderr.write(`${s.platform}  ${s.name}  ${DIM}→ ${where}${s.url ? `  ${s.url}` : ""}  (${s.id})${RESET}\n`);
      }
      if (!sources.length) process.stderr.write(`${DIM}No linked account or public form${verb ? "" : " files into this project (tfa-cli project sources all: every linked account)"}${RESET}\n`);
      return;
    }
    if (verb === "set") {
      const usage = 'Usage: tfa-cli project sources set <platform|id> workflow="<name>" | group=<slug>';
      const { workflow: flow, group, ...other } = parseAssignments(fields);
      if (!which || !!flow === !!group || Object.keys(other).length) fail(usage);
      const found = (await api.listMySources()).filter((s: any) => s.id === which || s.platform === which);
      if (found.length !== 1) fail(found.length ? `${found.length} linked accounts match "${which}": use the id (tfa-cli project sources all)` : `No linked account "${which}". Link one in the app (/slack, /discord, /x, /instagram, /reddit)`);
      const into = flow ? flows.filter((f) => f.id === flow || f.name === flow) : [];
      if (flow && into.length !== 1) fail(into.length ? `${into.length} workflows are named "${flow}": use the id` : `No workflow "${flow}". tfa-cli workflow lists them`);
      await api.setSourceTarget(projectId, found[0], flow ? { flow: into[0].id } : { group });
      process.stderr.write(`${GREEN}✅ ${found[0].platform} ${found[0].name} → ${flow ? `workflow "${into[0].name}"` : `group ${group}`}${RESET}\n`);
      return;
    }
    fail(`Unknown 'project sources' verb: ${verb}`);
  }
  if (sub === "surfaces") {
    const [verb, ...sargs] = rest;
    if (!verb) {
      const surfaces = await api.listProjectSurfaces(projectId);
      if (args.json) { console.log(JSON.stringify(surfaces, null, 2)); return; }
      // A note's title is usually its first line.
      const titleOf = (s: any) => s.title || (s.body ?? "").split("\n").find((l: string) => l.trim())?.trim().slice(0, 60) || "";
      for (const s of surfaces) process.stderr.write(`${s.id}  ${titleOf(s)}  ${DIM}${[s.ref ?? "note", s.group && `in ${s.group}`, s.color].filter(Boolean).join("  ")}${RESET}\n`);
      return;
    }
    if (verb === "set") {
      const [id, ...fields] = sargs;
      if (!id) fail("Usage: tfa-cli project surfaces set <id> [ref=<ref>|body=…] [title=…] [group=<slug>] [color=#hex] [order=N]");
      const surface = await api.upsertProjectSurface(projectId, id, parseAssignments(fields));
      if (args.json) { console.log(JSON.stringify(surface, null, 2)); return; }
      process.stderr.write(`${GREEN}✅ surface ${id} ${surface.ref ? `shows ${surface.ref}` : "is a note"}${surface.group ? ` in ${surface.group}` : ""}${RESET}\n`);
      return;
    }
    if (verb === "rm") {
      const [id] = sargs;
      if (!id) fail("Usage: tfa-cli project surfaces rm <id>");
      await api.deleteProjectSurface(projectId, id);
      process.stderr.write(`${GREEN}✅ surface ${id} removed${RESET}\n`);
      return;
    }
    fail(`Unknown 'project surfaces' verb: ${verb}`);
  }
  fail(`Unknown 'project' subcommand: ${sub}`);
}

// ── brand (business context) + voice ─────────────────────────────────

export function printBrandHelp() {
  process.stderr.write(`
tfa-cli brand — the project's brand page and its learned writing voice

The project IS the brand. --project <id>, $TODOFORAI_PROJECT_ID, or the configured default selects it.
The brand page text itself is a file: read/write todoforai:business-context.

Usage:
  tfa-cli brand [show]                             This project's brand (none = personal board)
  tfa-cli brand create <name>                      Give the project a brand page (empty .md); the board turns business
  tfa-cli brand rename <name>
  tfa-cli brand voice                              Learned profile + sources
  tfa-cli brand voice answers [<q>=<a>…]           Show / set the Manual source: answers to the style questions
  tfa-cli brand voice collect <channel> [--url U | --max N]
                                                   Add a writing sample source.
                                                   On this device (signed-in CLI, reply pairs):
                                                     Gmail (zele)  Outlook (outlook-api)  Chat (tfa-memory)
                                                   Server-side (--url):
                                                     X LinkedIn Facebook Instagram
                                                   --account  one Gmail mailbox (default: each signed-in
                                                              mailbox as its own voice) or Page id
                                                   --dry-run  print the samples as JSONL, store nothing
  tfa-cli brand voice check [<channel>|--all]      Can this device read the channel? tool, login, sample count
  tfa-cli brand voice remove <channel>
  tfa-cli brand voice learn [--from-company]       Run the refinement loop, store the profile
  tfa-cli brand voice correct "<what is off>"      Tell the learner what it got wrong; profile is updated
                                                   in one pass and the correction is kept for every re-learn

  Every voice verb takes --scope mine|project — which voice to teach:
    mine      yours, only in this project (default)
    project   the project's, shared with its members (needs write access)
  On the same voice name the narrower wins: mine > project.


Questions the UI asks (keys for 'answers'):
  "What makes you different from competitors?"
  "What are you working on right now?"
  "A frustrated customer says things aren't working. How do you reply?"
`);
}

export async function brandCommand(api: ApiClient, positionals: string[], args: Record<string, any>, scoped?: string) {
  const [, sub, ...rest] = positionals;
  const projectId = scoped || fail(NO_PROJECT);
  if (!sub || sub === "show") {
    const brand = await api.getBusinessContext(projectId);
    if (args.json) { console.log(JSON.stringify(brand, null, 2)); return; }
    process.stderr.write(brand ? `${brand.name}  ${DIM}${brand.id}${RESET}\n` : `${DIM}(personal board — no brand)${RESET}\n`);
    return;
  }
  if (sub === "create") {
    if (!rest[0]) fail("Usage: tfa-cli brand create <name>");
    const c = await api.createBusinessContext(projectId, rest[0]);
    if (args.json) { console.log(JSON.stringify(c, null, 2)); return; }
    process.stderr.write(`${GREEN}✅ brand ${c.name} created ${DIM}${c.id}${RESET}\n`);
    return;
  }
  if (sub === "rename") {
    if (!rest[0]) fail("Usage: tfa-cli brand rename <name>");
    await api.renameBusinessContext(projectId, rest[0]);
    process.stderr.write(`${GREEN}✅ renamed to ${rest[0]}${RESET}\n`);
    return;
  }
  if (sub === "voice") return voiceCommand(api, projectId, rest, args);
  fail(`Unknown 'brand' subcommand: ${sub}`);
}

/** Reads the channel on this device and prints JSONL — no account needed, so the web UI can run it on any host. */
function dryCollect(channel: string, max: number, account?: string) {
  const reason = checkChannel(channel);
  if (reason) fail(`${channel}: ${reason}`);
  const { samples, note } = collectChannel(channel, max, account);
  for (const x of samples) console.log(JSON.stringify(x));
  process.stderr.write(`${DIM}${samples.length} samples${note ? ` · ${note}` : ""} (not stored)${RESET}\n`);
}

/** `brand voice check|collect --dry-run`: read the channel on this device only. Returns false when the verb needs the API. */
export async function voiceDeviceCommand(rest: string[], args: Record<string, any>): Promise<boolean> {
  const [verb, ...vargs] = rest;
  if (verb === "check") {
    const channels = args.all || !vargs[0] ? DEVICE_CHANNELS : [vargs[0]];
    let failed = 0;
    const report: Record<string, { ok: boolean; reason?: string; samples?: number; note?: string }> = {};
    for (const ch of channels) {
      const reason = checkChannel(ch);
      if (reason) { failed++; report[ch] = { ok: false, reason }; continue; }
      try {
        const r = collectChannel(ch, Number(args.max ?? 10));
        const bad = r.samples.filter((x) => !x.text.trim() || (ADAPTERS[ch] && !x.prompt)).length; // reply channels must carry the prompt
        const ok = r.samples.length > 0 && bad === 0;
        if (!ok) failed++;
        report[ch] = { ok, samples: r.samples.length, ...(r.note && { note: r.note }), ...(bad ? { reason: `${bad} sample(s) without a prompt` } : r.samples.length ? {} : { reason: "no samples came back" }) };
      } catch (e: any) { failed++; report[ch] = { ok: false, reason: e.message }; }
    }
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else for (const [ch, r] of Object.entries(report)) process.stderr.write(`${r.ok ? GREEN + "✅" : RED + "❌"} ${ch}${RESET}  ${DIM}${r.ok ? `${r.samples} samples${r.note ? ` · ${r.note}` : ""}` : r.reason}${RESET}\n`);
    process.exit(failed ? 1 : 0);
  }
  if (verb === "collect" && args["dry-run"]) {
    if (!vargs[0]) fail("Usage: tfa-cli brand voice collect <channel> --dry-run [--account <email>] [--max N]");
    dryCollect(vargs[0], Number(args.max ?? 40), args.account);
    return true;
  }
  return false;
}

async function voiceCommand(api: ApiClient, projectId: string, rest: string[], args: Record<string, any>) {
  const [verb, ...vargs] = rest;
  const scope = (args.scope ?? "mine") as VoiceScope;
  if (!["project", "mine"].includes(scope)) fail(`--scope must be mine or project, got '${scope}'`);
  if (verb === "collect" && !vargs[0]) fail("Usage: tfa-cli brand voice collect <channel> [--url U | --account <page-id or mailbox> | --max N] [--dry-run]");
  // The voice belongs to the project, not the brand page: no brand is needed to teach or learn it.

  // Manual answers are the project's "Manual" voice source: Q → A samples, one bucket.
  if (verb === "answers") {
    const answers = manualAnswersOf((await api.listVoiceSources(projectId, scope)).sources);
    if (vargs.length) {
      for (const a of vargs) { const i = a.indexOf("="); if (i < 1) fail(`Expected question=answer, got '${a}'`); answers[a.slice(0, i)] = a.slice(i + 1); }
      await api.collectVoiceSource(projectId, MANUAL_CHANNEL, { samples: manualSamples(answers), scope });
      process.stderr.write(`${GREEN}✅ ${vargs.length} answer(s) saved${RESET}\n`);
      return;
    }
    if (args.json) { console.log(JSON.stringify(answers, null, 2)); return; }
    for (const [q, a] of Object.entries(answers)) process.stderr.write(`${q}\n  ${DIM}${a || "(empty)"}${RESET}\n`);
    return;
  }

  if (!verb || verb === "show") {
    const [{ sources, profile }, brand] = await Promise.all([api.listVoiceSources(projectId, scope), api.getBusinessContext(projectId)]);
    if (args.json) { console.log(JSON.stringify({ brand, profile, sources }, null, 2)); return; }
    if (brand) process.stderr.write(`${brand.name}  ${DIM}${brand.id}${RESET}\n`);
    process.stderr.write(profile ? `\n${profile.profile}\n${DIM}match ${profile.match}/100 · source ${profile.source}${RESET}\n` : `${DIM}(no voice learned yet)${RESET}\n`);
    const names = voiceNamesOf(sources);
    for (const [i, s] of sources.entries()) process.stderr.write(`  ${names[i]}${s.account ? ` ${DIM}(${s.account})${RESET}` : ""}  ${DIM}${s.posts ?? "?"} posts · ${s.chars ?? "?"} chars${RESET}\n`);
    return;
  }
  if (verb === "collect") {
    const channel = vargs[0];
    // Signed-in CLI on this device beats a crawl: full history, real reply pairs.
    const onDevice = !args.url && ADAPTERS[channel];
    if (onDevice) {
      const reason = checkChannel(channel);
      if (reason) fail(`${channel}: ${reason}`);
      // A mailbox is a voice: several signed-in accounts are read and stored one by one, never merged.
      const accounts: (string | undefined)[] = args.account ? [args.account] : ADAPTERS[channel].accounts?.() ?? [undefined];
      let stored = 0;
      for (const account of accounts) {
        process.stderr.write(`${DIM}reading ${channel}${account ? ` ${account}` : ""} on this device…${RESET}\n`);
        const { samples, note } = collectChannel(channel, Number(args.max ?? 40), account);
        if (!samples.length) { process.stderr.write(`${RED}${channel}${account ? ` ${account}` : ""}: nothing usable came back${note ? ` (${note})` : ""}${RESET}\n`); continue; }
        const { sources } = await api.collectVoiceSource(projectId, channel, { samples, account, scope });
        process.stderr.write(`${GREEN}✅ ${channel}${account ? ` ${account}` : ""}: ${samples.length} reply pairs stored (${sources.length} source(s))${RESET}\n`);
        stored++;
      }
      if (!stored) process.exit(1);
      return;
    }
    const { sources } = await api.collectVoiceSource(projectId, channel, { url: args.url, account: args.account, scope });
    process.stderr.write(`${GREEN}✅ ${channel} collected (${sources.length} source(s))${RESET}\n`);
    return;
  }
  if (verb === "remove") {
    if (!vargs[0]) fail("Usage: tfa-cli brand voice remove <channel> [--account <id>]   (no --account: every source of the channel)");
    await api.removeVoiceSource(projectId, vargs[0], { ...(args.account ? { account: args.account } : { all: true }), scope });
    process.stderr.write(`${GREEN}✅ ${vargs[0]} removed${RESET}\n`);
    return;
  }
  if (verb === "learn") {
    process.stderr.write(`${DIM}learning voice…${RESET}\n`);
    const res = await api.refineBrandVoice(projectId, args["from-company"] ? "company" : undefined, undefined, scope);
    if (!res.profile) fail(args["from-company"] ? "No brand page to learn from — 'tfa-cli brand create <name>' and fill it first" : "Nothing to learn from — add answers, collect a source, or fill the brand page first");
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return; }
    process.stderr.write(`${GREEN}✅ voice learned (match ${res.match}/100, source ${res.source})${RESET}\n${res.profile}\n`);
    return;
  }
  if (verb === "correct") {
    const text = vargs.join(" ").trim();
    if (!text) fail('Usage: tfa-cli brand voice correct "<what is off>"');
    if (!(await api.listVoiceSources(projectId, scope)).profile?.profile) fail("No voice learned yet — 'tfa-cli brand voice learn' first");
    process.stderr.write(`${DIM}applying correction…${RESET}\n`);
    const res = await api.refineBrandVoice(projectId, undefined, text, scope);
    if (!res.profile) fail("The correction pass returned nothing — try rewording it");
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return; }
    const last = res.iterations[res.iterations.length - 1];
    process.stderr.write(`${GREEN}✅ voice corrected (match ${res.match}/100)${RESET}\n${res.profile}\n${DIM}sample: ${last?.sample ?? ""}${RESET}\n`);
    return;
  }
  fail(`Unknown 'brand voice' verb: ${verb}`);
}

// ── device ───────────────────────────────────────────────────────────

export function printDeviceHelp() {
  process.stderr.write(`
tfa-cli device — the user's paired machines

Usage:
  tfa-cli device list
  tfa-cli device rename <device> <name>        name: [a-zA-Z0-9][a-zA-Z0-9_]*, ≤64
  tfa-cli device wallpaper <device> auto|off   desktop-wallpaper capture (off deletes stored images)
  tfa-cli device access <device>               who you shared the device with
  tfa-cli device share <device> <email>        let a teammate use it (their runs act as THEM)
  tfa-cli device unshare <device> <email>
  tfa-cli device leave <device>                remove your own access to a shared device

<device> is an id, name or hostname (unique partial works).
Devices shared with you are marked "shared"; only the owner can rename/share them.
exec / reboot / update / unpair / workspace paths / share are UI-only from an agent shell.
`);
}

export async function deviceCommand(api: ApiClient, positionals: string[], args: Record<string, any>) {
  const [, sub, query, value] = positionals;
  const devices: any[] = await api.listDevices();
  if (!sub || sub === "list") {
    if (args.json) { console.log(JSON.stringify(devices, null, 2)); return; }
    // Only the owner's view carries accessIds, so its absence marks a device lent to us.
    for (const d of devices) {
      const sharing = !d.accessIds ? " shared with you" : d.accessIds.length ? ` shared ×${d.accessIds.length}` : "";
      process.stderr.write(`${d.status === "ONLINE" ? GREEN + "●" : DIM + "○"}${RESET} ${d.name}  ${DIM}${d.deviceType} ${d.metadata?.identity?.hostname ?? ""} ${d.id}${sharing}${RESET}\n`);
    }
    return;
  }
  if (!query) fail(`Usage: tfa-cli device ${sub} <device> …`);
  const q = query.toLowerCase();
  const hit = devices.filter((d) => d.id === query || d.name.toLowerCase() === q || d.metadata?.identity?.hostname?.toLowerCase() === q);
  const found = hit.length === 1 ? hit[0] : (() => {
    const p = devices.filter((d) => d.id.startsWith(query) || d.name.toLowerCase().includes(q) || d.metadata?.identity?.hostname?.toLowerCase().includes(q));
    if (p.length === 1) return p[0];
    fail(p.length ? `Ambiguous device '${query}'` : `No device matching '${query}'`);
  })();
  if (sub === "rename") {
    if (!value) fail("Usage: tfa-cli device rename <device> <name>");
    await api.renameDevice(found.id, value);
    process.stderr.write(`${GREEN}✅ ${found.name} → ${value}${RESET}\n`);
    return;
  }
  if (sub === "leave") {
    await api.leaveDevice(found.id);
    process.stderr.write(`${GREEN}✅ Removed ${found.name} from your devices${RESET}\n`);
    return;
  }
  if (sub === "access" || sub === "share" || sub === "unshare") {
    if (sub !== "access" && !value) fail(`Usage: tfa-cli device ${sub} <device> <email>`);
    const list = sub === "access" ? await api.getDeviceAccess(found.id)
      : sub === "share" ? await api.shareDevice(found.id, value) : await api.unshareDevice(found.id, value);
    if (args.json) { console.log(JSON.stringify(list, null, 2)); return; }
    if (sub !== "access") process.stderr.write(`${GREEN}✅ ${found.name} ${sub === "share" ? "shared with" : "no longer shared with"} ${value}${RESET}\n`);
    process.stderr.write(list.length ? list.map((u) => `  ${u.email}${u.name ? ` ${DIM}(${u.name})${RESET}` : ""}\n`).join("") : `  ${DIM}not shared${RESET}\n`);
    return;
  }
  if (sub === "wallpaper") {
    if (value !== "auto" && value !== "off") fail("Usage: tfa-cli device wallpaper <device> auto|off");
    await api.setDeviceWallpaperMode(found.id, value);
    process.stderr.write(`${GREEN}✅ ${found.name} wallpaper: ${value}${RESET}\n`);
    return;
  }
  fail(`Unknown 'device' subcommand: ${sub}`);
}
