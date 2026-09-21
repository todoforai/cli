/** `todo` and `project` subcommands — field-level edits of a todo / project via field=value. */

import type { ApiClient } from "@shared/api";
import { parseAssignments, resolveAgent } from "./agent-command";
import { getEnv } from "./args";
import { getDisplayName, getItemId } from "./select";
import { DIM, GREEN, RED, RESET } from "./colors";
import { ADAPTERS, DEVICE_CHANNELS, checkChannel, collectChannel } from "./voice-collect";

export function printTodoHelp() {
  process.stderr.write(`
tfa-cli todo — edit a todo's fields

Usage:
  tfa-cli todo set <todo-id|-> <field=value>…   Update fields ("-" = $TODOFORAI_TODO_ID)
  tfa-cli todo restore <todo-id>                Bring a trashed todo back (undo of 'delete')

Fields (PUT /todos/{id}):
  title            first-line content (alias: content)
  group            group slug; "" makes it ungrouped (alias: groupTag)
  star             true|false (starredAt now / 0)
  schedule         unix ms timestamp, 0 = immediate (alias: scheduledTimestamp)
  agent            agentSettingsId (alias: agentSettingsId)
  brand            businessContextId (alias: businessContextId)
  public           true|false — refused from an agent shell (isPublic)

  tfa-cli todo message <todo-id|-> <message-id> <field=value>…
                   Edit a SCHEDULED (not yet run) message: content, schedule (unix ms;
                   0 = run now). Runs with the todo's own agent.

Examples:
  tfa-cli todo set - title="Ship v2 landing" group=marketing
  tfa-cli todo set 3f2a91 star=true
  tfa-cli todo message - 8c1d… schedule=1760000000000
  tfa-cli status <todo-id> DONE                  (status has its own command)
`);
}

export function printProjectHelp() {
  process.stderr.write(`
tfa-cli project — edit the current project

--project <id> or $TODOFORAI_PROJECT_ID selects the project.

Usage:
  tfa-cli project list                             Projects you can access (* = default)
  tfa-cli project set <field=value>…               name=… description=… brand=<businessContextId>
                                                    (isPublic refused from an agent shell)
  tfa-cli project default                          Make it the project you land on at /
  tfa-cli project agent <agent>                    Default agent for new todos in this project
  tfa-cli project settings <field=value>…          Project settings (PUT /settings/projects/{id})
  tfa-cli project groups                           List todo groups
  tfa-cli project groups set <slug> <field=value>… Create/update a group: name description pinned archived order
  tfa-cli project groups reorder <slug>…           Set wall order
  tfa-cli project surfaces                         List the board's card surfaces (live refs shown as cards)
  tfa-cli project surfaces set <id> ref=<ref> [title=…] [group=<slug>] [order=N]
                                                   Show a ref on the board: a todo id, <todoId>:<alias>
                                                   (shown artifact) or an http(s) url. group= puts it
                                                   inside that group's card; group="" makes it standalone.
  tfa-cli project surfaces rm <id>                 Take it off the board

Examples:
  tfa-cli project set name="Q4 launch"
  tfa-cli project groups set marketing name=Marketing description="Top-of-funnel work"
  tfa-cli project groups reorder marketing sales ops
  tfa-cli project surfaces set weekly-kpis ref=$TODOFORAI_TODO_ID:kpi title="Weekly KPIs" group=marketing
`);
}

const TODO_ALIASES: Record<string, string> = {
  title: "content",
  group: "groupTag",
  schedule: "scheduledTimestamp",
  agent: "agentSettingsId",
  brand: "businessContextId",
  public: "isPublic",
};

const PROJECT_ALIASES: Record<string, string> = { brand: "businessContextId" };

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
  if (sub !== "set") { printTodoHelp(); process.exit(sub ? 2 : 0); }
  if (!todoId || !rest.length) fail("Usage: tfa-cli todo set <todo-id|-> <field=value>…");
  const updates = parseAssignments(rest, TODO_ALIASES);
  if ("star" in updates) {
    if (typeof updates.star !== "boolean") fail("star must be true or false");
    updates.starredAt = updates.star ? Date.now() : 0;
    delete updates.star;
  }
  await api.updateTodo(todoId, updates);
  if (args.json) { console.log(JSON.stringify({ todoId, ...updates })); return; }
  process.stderr.write(`${GREEN}✅ ${todoId} updated: ${Object.keys(updates).join(", ")}${RESET}\n`);
}

export async function projectCommand(api: ApiClient, positionals: string[], args: Record<string, any>) {
  const [, sub, ...rest] = positionals;
  const projectId = (args.project as string) || getEnv("PROJECT_ID");
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
  if (!projectId) fail("No project — pass --project <id> or set TODOFORAI_PROJECT_ID");

  if (sub === "set") {
    if (!rest.length) fail("Usage: tfa-cli project set <field=value>…");
    const updates = parseAssignments(rest, PROJECT_ALIASES);
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
      for (const g of groups) process.stderr.write(`${getItemId(g) || g.slug}  ${g.name ?? ""}  ${DIM}${g.description ?? ""}${RESET}\n`);
      return;
    }
    if (verb === "set") {
      const [slug, ...fields] = gargs;
      if (!slug) fail("Usage: tfa-cli project groups set <slug> <field=value>…");
      const group = await api.upsertProjectGroup(projectId, slug, parseAssignments(fields));
      if (args.json) { console.log(JSON.stringify(group, null, 2)); return; }
      process.stderr.write(`${GREEN}✅ group ${slug} saved${RESET}\n`);
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
  if (sub === "surfaces") {
    const [verb, ...sargs] = rest;
    if (!verb) {
      const surfaces = await api.listProjectSurfaces(projectId);
      if (args.json) { console.log(JSON.stringify(surfaces, null, 2)); return; }
      for (const s of surfaces) process.stderr.write(`${s.id}  ${s.ref}  ${DIM}${[s.title, s.group && `in ${s.group}`].filter(Boolean).join("  ")}${RESET}\n`);
      return;
    }
    if (verb === "set") {
      const [id, ...fields] = sargs;
      if (!id) fail("Usage: tfa-cli project surfaces set <id> ref=<ref> [title=…] [group=<slug>] [order=N]");
      const surface = await api.upsertProjectSurface(projectId, id, parseAssignments(fields));
      if (args.json) { console.log(JSON.stringify(surface, null, 2)); return; }
      process.stderr.write(`${GREEN}✅ surface ${id} shows ${surface.ref}${surface.group ? ` in ${surface.group}` : ""}${RESET}\n`);
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
tfa-cli brand — business contexts (brands) and the learned writing voice

The brand page text itself is a file: read/write todoforai:business-context.
These commands manage the contexts and the voice learned for them.

Usage:
  tfa-cli brand list                               Contexts (* = selected)
  tfa-cli brand create <name>                      New brand (empty .md page)
  tfa-cli brand rename <brand> <name>
  tfa-cli brand select <brand|none>                Active brand for the account
  tfa-cli brand voice                              Learned profile + sources
  tfa-cli brand voice answers [<q>=<a>…]           Show / set the brand-voice answers (strings)
  tfa-cli brand voice collect <channel> [--url U | --pasted-file <F|-> | --max N]
                                                   Add a writing sample source.
                                                   On this device (signed-in CLI, reply pairs):
                                                     Gmail (zele)  Outlook (outlook-api)  Chat (tfa-memory)
                                                   Server-side (--url or paste):
                                                     X LinkedIn Facebook Instagram Slack Teams
                                                   --dry-run  print the samples as JSONL, store nothing
  tfa-cli brand voice check [<channel>|--all]      Can this device read the channel? tool, login, sample count
  tfa-cli brand voice remove <channel>
  tfa-cli brand voice learn [--from-company]       Run the refinement loop, store the profile
  tfa-cli brand voice correct "<what is off>"      Tell the learner what it got wrong; profile is updated
                                                   in one pass and the correction is kept for every re-learn

<brand> is an id or name (unique partial works). Voice subcommands use the
selected brand unless --brand <id|name> is given (--pasted-file - reads stdin).
Delete / reset are UI-only.

Questions the UI asks (keys for 'answers'):
  "What makes you different from competitors?"
  "What are you working on right now?"
  "A frustrated customer says things aren't working. How do you reply?"
`);
}

async function resolveBrand(api: ApiClient, query: string | undefined, selectedId?: string): Promise<any> {
  const contexts: any[] = await api.listBusinessContexts();
  if (!query) {
    const sel = contexts.find((c) => c.id === selectedId);
    if (sel) return sel;
    if (contexts.length === 1) return contexts[0];
    fail("No brand selected — pass --brand <id|name> or 'tfa-cli brand select'");
  }
  const q = query.toLowerCase();
  const exact = contexts.find((c) => c.id === query || c.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = contexts.filter((c) => c.id.startsWith(query) || c.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  fail(partial.length ? `Ambiguous brand '${query}'` : `No brand matching '${query}'`);
}

export async function brandCommand(api: ApiClient, positionals: string[], args: Record<string, any>) {
  const [, sub, ...rest] = positionals;
  if (!sub || sub === "list") {
    const contexts: any[] = await api.listBusinessContexts();
    const selected = (await api.getProfile()).user?.selectedBusinessContextId;
    if (args.json) { console.log(JSON.stringify(contexts.map((c) => ({ ...c, selected: c.id === selected })), null, 2)); return; }
    for (const c of contexts) process.stderr.write(`${c.id === selected ? "*" : " "} ${c.name}  ${DIM}${c.id}${RESET}\n`);
    return;
  }
  if (sub === "create") {
    if (!rest[0]) fail("Usage: tfa-cli brand create <name>");
    const c = await api.createBusinessContext(rest[0]);
    if (args.json) { console.log(JSON.stringify(c, null, 2)); return; }
    process.stderr.write(`${GREEN}✅ brand ${c.name} created ${DIM}${c.id}${RESET}\n`);
    return;
  }
  if (sub === "rename") {
    if (!rest[1]) fail("Usage: tfa-cli brand rename <brand> <name>");
    const c = await resolveBrand(api, rest[0]);
    await api.renameBusinessContext(c.id, rest[1]);
    process.stderr.write(`${GREEN}✅ renamed to ${rest[1]}${RESET}\n`);
    return;
  }
  if (sub === "select") {
    if (!rest[0]) fail("Usage: tfa-cli brand select <brand|none>");
    const id = rest[0] === "none" ? null : (await resolveBrand(api, rest[0])).id;
    await api.selectBusinessContext(id);
    process.stderr.write(`${GREEN}✅ selected brand: ${id ?? "none"}${RESET}\n`);
    return;
  }
  if (sub === "voice") return voiceCommand(api, rest, args);
  fail(`Unknown 'brand' subcommand: ${sub}`);
}

/** Reads the channel on this device and prints JSONL — no account needed, so the web UI can run it on any host. */
function dryCollect(channel: string, max: number) {
  const reason = checkChannel(channel);
  if (reason) fail(`${channel}: ${reason}`);
  const { samples, note } = collectChannel(channel, max);
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
    if (!vargs[0]) fail("Usage: tfa-cli brand voice collect <channel> --dry-run [--max N]");
    dryCollect(vargs[0], Number(args.max ?? 40));
    return true;
  }
  return false;
}

async function voiceCommand(api: ApiClient, rest: string[], args: Record<string, any>) {
  const [verb, ...vargs] = rest;
  if (verb === "collect" && !vargs[0]) fail("Usage: tfa-cli brand voice collect <channel> [--url U | --pasted-file F|- | --max N] [--dry-run]");
  const onboarding = await api.getOnboarding();

  if (verb === "answers") {
    if (vargs.length) {
      const given = Object.fromEntries(vargs.map((a) => { const i = a.indexOf("="); if (i < 1) fail(`Expected question=answer, got '${a}'`); return [a.slice(0, i), a.slice(i + 1)]; }));
      const styleAnswers = { ...(onboarding.styleAnswers ?? {}), ...given };
      await api.patchOnboarding({ styleAnswers });
      process.stderr.write(`${GREEN}✅ ${vargs.length} answer(s) saved${RESET}\n`);
      return;
    }
    const answers = onboarding.styleAnswers ?? {};
    if (args.json) { console.log(JSON.stringify(answers, null, 2)); return; }
    for (const [q, a] of Object.entries(answers)) process.stderr.write(`${q}\n  ${DIM}${a || "(empty)"}${RESET}\n`);
    return;
  }

  const brand = await resolveBrand(api, args.brand, (await api.getProfile()).user?.selectedBusinessContextId);

  if (!verb || verb === "show") {
    const profile = onboarding.voiceProfiles?.[brand.id];
    const { sources } = await api.listVoiceSources(brand.id);
    if (args.json) { console.log(JSON.stringify({ brand, profile, sources }, null, 2)); return; }
    process.stderr.write(`${brand.name}  ${DIM}${brand.id}${RESET}\n`);
    process.stderr.write(profile ? `\n${profile.profile}\n${DIM}match ${profile.match}/100 · source ${profile.source}${RESET}\n` : `${DIM}(no voice learned yet)${RESET}\n`);
    for (const s of sources) process.stderr.write(`  ${s.channel}  ${DIM}${s.posts ?? "?"} posts · ${s.chars ?? "?"} chars${RESET}\n`);
    return;
  }
  if (verb === "collect") {
    const channel = vargs[0];
    let pasted: string | undefined;
    if (args["pasted-file"]) {
      const { readFileSync } = await import("node:fs");
      pasted = readFileSync(args["pasted-file"] === "-" ? 0 : args["pasted-file"], "utf8");
    }
    // Signed-in CLI on this device beats a crawl: full history, real reply pairs.
    const onDevice = !pasted && !args.url && ADAPTERS[channel];
    if (onDevice) {
      const reason = checkChannel(channel);
      if (reason) fail(`${channel}: ${reason}`);
      process.stderr.write(`${DIM}reading ${channel} on this device…${RESET}\n`);
      const { samples, note } = collectChannel(channel, Number(args.max ?? 40));
      if (!samples.length) fail(`${channel}: nothing usable came back${note ? ` (${note})` : ""}`);
      const { sources } = await api.collectVoiceSource(brand.id, channel, { samples });
      process.stderr.write(`${GREEN}✅ ${channel}: ${samples.length} reply pairs stored (${sources.length} source(s))${RESET}\n`);
      return;
    }
    const { sources } = await api.collectVoiceSource(brand.id, channel, { url: args.url, pasted });
    process.stderr.write(`${GREEN}✅ ${channel} collected (${sources.length} source(s))${RESET}\n`);
    return;
  }
  if (verb === "remove") {
    if (!vargs[0]) fail("Usage: tfa-cli brand voice remove <channel>");
    await api.removeVoiceSource(brand.id, vargs[0]);
    process.stderr.write(`${GREEN}✅ ${vargs[0]} removed${RESET}\n`);
    return;
  }
  if (verb === "learn") {
    process.stderr.write(`${DIM}learning voice for ${brand.name}…${RESET}\n`);
    const res = await api.refineBrandVoice(brand.id, onboarding.styleAnswers ?? {}, args["from-company"] ? "company" : undefined);
    if (!res.profile) fail("Nothing to learn from — add answers or collect a source first");
    const { [brand.id]: _stale, ...styleAiAnswers } = onboarding.styleAiAnswers ?? {};
    await api.patchOnboarding({
      voiceProfiles: { ...(onboarding.voiceProfiles ?? {}), [brand.id]: { ...res, updatedAt: Date.now() } },
      styleAiAnswers,
    });
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return; }
    process.stderr.write(`${GREEN}✅ voice learned (match ${res.match}/100, source ${res.source})${RESET}\n${res.profile}\n`);
    return;
  }
  if (verb === "correct") {
    const text = vargs.join(" ").trim();
    if (!text) fail('Usage: tfa-cli brand voice correct "<what is off>"');
    const stored = onboarding.voiceProfiles?.[brand.id];
    if (!stored?.profile) fail("No voice learned yet — 'tfa-cli brand voice learn' first");
    process.stderr.write(`${DIM}applying correction…${RESET}\n`);
    const res = await api.refineBrandVoice(brand.id, onboarding.styleAnswers ?? {}, undefined, text);
    if (!res.profile) fail("The correction pass returned nothing — try rewording it");
    const { [brand.id]: _stale, ...styleAiAnswers } = onboarding.styleAiAnswers ?? {};
    await api.patchOnboarding({ voiceProfiles: { ...(onboarding.voiceProfiles ?? {}), [brand.id]: { ...res, updatedAt: Date.now() } }, styleAiAnswers });
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

<device> is an id, name or hostname (unique partial works).
exec / reboot / update / unpair / workspace paths are UI-only from an agent shell.
`);
}

export async function deviceCommand(api: ApiClient, positionals: string[], args: Record<string, any>) {
  const [, sub, query, value] = positionals;
  const devices: any[] = await api.listDevices();
  if (!sub || sub === "list") {
    if (args.json) { console.log(JSON.stringify(devices, null, 2)); return; }
    for (const d of devices) process.stderr.write(`${d.status === "ONLINE" ? GREEN + "●" : DIM + "○"}${RESET} ${d.name}  ${DIM}${d.deviceType} ${d.metadata?.identity?.hostname ?? ""} ${d.id}${RESET}\n`);
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
  if (sub === "wallpaper") {
    if (value !== "auto" && value !== "off") fail("Usage: tfa-cli device wallpaper <device> auto|off");
    await api.setDeviceWallpaperMode(found.id, value);
    process.stderr.write(`${GREEN}✅ ${found.name} wallpaper: ${value}${RESET}\n`);
    return;
  }
  fail(`Unknown 'device' subcommand: ${sub}`);
}
