#!/usr/bin/env bun
/**
 * TODOforAI CLI (Bun) — Create and manage todos
 * Usage: tfa-cli "prompt text" | echo "content" | todoforai-cli [options]
 */

import { realpathSync, readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import path from "path";

import { checkForUpdates } from "@todoforai/update-notifier";
import { randomTip } from "./tips";

try {
  const pkgPath = path.resolve(fileURLToPath(import.meta.url), "../../package.json");
  checkForUpdates(JSON.parse(readFileSync(pkgPath, "utf-8")));
} catch {}
import { ApiClient, restBasePath, FrontendWebSocket, type RegistrySpec } from "@shared/api";
import { qualifiedModelIds } from "@shared/fbe";
import { normalizeApiUrl } from "@shared/credentials";

import { DEFAULT_API_URL, VERSION, getEnv, printUsage, printStatusHelp, parseCliArgs } from "./args";
import { readMultiline, readStdin } from "./input";
import { getAgentWorkspacePaths, autoCreateAgent } from "./agent";
import { ConfigStore } from "./config";
import { readCredential, writeCredential } from "./credentials";
import { BRIGHT_WHITE, CYAN, DIM, GREEN, YELLOW, RED, BRAND, RESET } from "./colors";
import { printLogo } from "./logo";
import { getFrontendUrl } from "./urls";
import { printFullChat, applySlice, toAnthropicShape, type InspectMode, type InspectFormat } from "./inspect";
import { selectProject, selectAgent, getDisplayName, getItemId, resolveAgentMatch } from "./select";
import { watchTodo } from "./watch";
import { listAgentsCommand } from "./list-agents";
import { agentCommand, printAgentHelp } from "./agent-command";
import { listTodosCommand, printListTodosHelp } from "./list-todos";
import { ensureBridgeRunning } from "./ensure-bridge";
import { spawnMayflyBridge } from "./isolated";

// ── helpers ──────────────────────────────────────────────────────────

function formatPathWithTilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? path.replace(home, "~") : path;
}


// ── interactive loop ─────────────────────────────────────────────────

async function interactiveLoop(
  ws: FrontendWebSocket,
  api: ApiClient,
  todoId: string,
  projectId: string,
  agent: any,
  json: boolean,
  autoApprove: boolean,
  cfg: ConfigStore,
) {
  while (true) {
    try {
      let activityResolve: (() => void) | null = null;
      const activityPromise = new Promise<void>((res) => { activityResolve = res; });

      // Lightweight callback — detect activity and buffer messages so none
      // are lost in the handoff to the full watchTodo callback.
      const ignoreActivity = new Set([
        "todo:msg_start", "todo:msg_done", "todo:msg_stop_sequence",
        "todo:msg_meta_ai", "todo:status", "todo:new_message_created",
        "block:end", "block:sh_msg_start", "block:sh_done",
      ]);
      const buffered: Array<[string, any]> = [];
      ws.setCallback(todoId, (msgType: string, payload: any) => {
        buffered.push([msgType, payload]);
        if (!ignoreActivity.has(msgType)) activityResolve?.();
      });

      const { promise: inputPromise, cancel: cancelInput } = readMultiline(`${BRIGHT_WHITE}TODO>${RESET} `, cfg.getHistory());

      const winner = await Promise.race([
        inputPromise.then((v) => ({ tag: "input" as const, value: v })),
        activityPromise.then(() => ({ tag: "activity" as const, value: "" })),
      ]);

      if (winner.tag === "activity") {
        // Server sent output — cancel prompt, hand buffered messages to watchTodo
        cancelInput();
        inputPromise.catch(() => {}); // swallow cancel rejection
        process.stderr.write("\r\x1b[K"); // clear prompt line
        await watchTodo(ws, todoId, projectId, {
          json, autoApprove, agentSettings: agent,
          replayMessages: buffered,
        });
        continue;
      }
      // User input won — remove lightweight callback
      ws.setCallback(todoId);

      const input = winner.value;
      if (!input) continue;
      if (["/exit", "/quit", "/q", "q", "exit"].includes(input)) break;
      if (["/help", "?"].includes(input)) {
        process.stderr.write("  /exit, /quit, /q  - quit\n  /help, ?          - show help\n");
        continue;
      }
      cfg.addToHistory(input);
      process.stderr.write("─".repeat(40) + "\n");
      await api.addMessage(projectId, input, agent, todoId);
      await watchTodo(ws, todoId, projectId, {
        json, autoApprove, agentSettings: agent,
      });
    } catch {
      break;
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  process.on("SIGINT", () => {
    process.stderr.write("\nCancelled by user (Ctrl+C)\n");
    process.exit(130);
  });

  const { values: args, positionals } = parseCliArgs();
  // Three states: omitted inherits, --group "" explicitly escapes, non-empty overrides.
  const groupTag = args.group === undefined ? getEnv("GROUP_ID") : String(args.group);
  const groupName = args["group-name"] === undefined ? undefined : String(args["group-name"]);

  // `start <id>` is sugar for `--template <id>`
  if (positionals[0] === "start") {
    if (!positionals[1] && !args.template) {
      process.stderr.write(`${RED}Usage: tfa-cli start <todo-id>${RESET}\n`);
      process.exit(2);
    }
    if (!args.template) args.template = positionals[1];
  }

  if (args.version) { console.log(VERSION); process.exit(0); }
  if (positionals[0] === "status" && args.help) { printStatusHelp(); process.exit(0); }
  if (positionals[0] === "agent" && args.help) { printAgentHelp(); process.exit(0); }
  if ((positionals[0] === "list" || positionals[0] === "ls") && args.help) { printListTodosHelp(); process.exit(0); }
  // Subcommands with their own --help handle it themselves.
  if (args.help && !["list", "ls", "agent"].includes(positionals[0])) { printUsage(); process.exit(0); }

  // ── flag compatibility — validated ONCE here, so no later branch can
  // silently ignore a flag (e.g. --template returning before an --isolated
  // check would fake isolation without providing it) ──
  if (args.isolated) {
    if (args.resume || args.continue) {
      process.stderr.write("Error: --isolated cannot be combined with --resume/--continue (isolation binds at create)\n");
      process.exit(2);
    }
    // The isolated bridge lives only as long as this CLI process — exiting right
    // after create (--no-watch) would kill it before the agent ever uses it.
    if (args["no-watch"]) {
      process.stderr.write("Error: --isolated requires watching the run (drop --no-watch)\n");
      process.exit(2);
    }
    // startFromSpec has no pre-minted-todoId path yet, so a template run cannot
    // bind a mayfly at create — fail loud rather than start unisolated.
    if (args.template) {
      process.stderr.write("Error: --isolated does not support --template yet\n");
      process.exit(2);
    }
  }

  // ensureBridgeRunning is intentionally NOT called here — it's invoked
  // per-branch below, only on paths that actually need the bridge daemon
  // (template / resume / create-todo). Read-only paths (--list-agents, --list-models,
  // --inspect, --show-config, login, etc.) must not spawn it, otherwise
  // tool-catalog probes like `todoforai-cli --version` from the bridge end up
  // forking yet another bridge — feedback loop.

  const cfg = new ConfigStore(args["config-path"] as string);

  // ── config commands ──
  if (args["show-config"]) {
    console.log(`Config file: ${formatPathWithTilde(cfg.path)}`);
    console.log(JSON.stringify(cfg.data, null, 2));
    return;
  }
  if (args["reset-config"]) {
    const { existsSync, unlinkSync } = await import("fs");
    if (existsSync(cfg.path)) { unlinkSync(cfg.path); console.log(`Configuration reset: ${formatPathWithTilde(cfg.path)}`); }
    else console.log("No configuration file to reset");
    return;
  }
  // ── resolve API URL (shared by login + normal flow) ──
  const apiUrl = normalizeApiUrl(
    (args["api-url"] as string) || getEnv("API_URL") || DEFAULT_API_URL,
  );
  const cfgScope = cfg.scope(apiUrl);
  if (args["user-id"]) {
    const url = new URL(apiUrl);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "http:" || !loopback) {
      process.stderr.write("Error: --user-id is restricted to HTTP loopback URLs\n");
      process.exit(2);
    }
  }

  // ── device login ──
  async function deviceLogin(): Promise<string> {
    const loginApi = new ApiClient(apiUrl, ""); // no key needed for init
    // clientName "edge" → backend mints a durable apiKey (handled below); "cli"/"bridge"
    // route to the device-credential branch that returns device/apiToken (no apiKey).
    const { code, url, expiresIn } = await loginApi.initDeviceLogin("edge");

    const userCode = new URL(url).searchParams.get("user_code") || code.slice(-8).toUpperCase();
    const formattedCode = userCode.length === 8 ? `${userCode.slice(0, 4)}-${userCode.slice(4)}` : userCode;
    process.stderr.write(`\n🔑 Open this URL to authorize:\n`);
    process.stderr.write(`${CYAN}${url}${RESET}\n`);
    process.stderr.write(`Verification code: ${BRIGHT_WHITE}${formattedCode}${RESET}\n\n`);

    // Best-effort open browser
    try {
      const { spawn } = await import("child_process");
      if (process.platform === "win32") {
        spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
      } else {
        const cmd = process.platform === "darwin" ? "open" : "xdg-open";
        spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
      }
    } catch {}

    process.stderr.write(`Waiting for approval (expires in ${Math.round(expiresIn / 60)}min)...\n`);
    const deadline = Date.now() + expiresIn * 1000;
    let failures = 0;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const poll = await loginApi.pollDeviceLogin(code);
        failures = 0;
        if (poll.status === "complete" && poll.apiKey) {
          writeCredential(apiUrl, poll.apiKey);
          process.stderr.write(`${GREEN}✅ Login successful! API key saved.${RESET}\n`);
          return poll.apiKey;
        }
        if (poll.status === "expired") break;
      } catch (e: any) {
        if (++failures >= 5) {
          process.stderr.write(`${RED}Poll failed: ${e.message}${RESET}\n`);
          process.exit(1);
        }
      }
    }
    process.stderr.write(`${RED}Login expired or failed.${RESET}\n`);
    process.exit(1);
  }

  if (positionals[0] === "login" && positionals.length === 1) {
    await deviceLogin();
    return;
  }

  // ── resolve API client ──
  // Priority: CLI flag > shared credentials.json > env token
  // (TODOFORAI_API_TOKEN, URL-blind) > device-login. readCredential resolves the
  // URL-keyed entry first, then the top-level apiToken bridge field the edge/login
  // writes, so a bridge-only credentials.json authenticates without a re-login.
  // dst_… device-session tokens (the edge injects one as TODOFORAI_API_TOKEN into
  // every shell child, and the bridge stores one as apiToken) only authenticate
  // on the /dst/v1 mount — ApiClient/restBasePath route them there, so they work
  // like any other token here (headless sandboxes have nothing else).
  let apiKey = (args["api-key"] as string)
    || readCredential(apiUrl)
    || getEnv("API_TOKEN")
    || "";

  if (!apiKey) {
    apiKey = await deviceLogin();
  }

  // --debug-dump: forward TODOFORAI_DEBUG_SECRET as x-tfa-debug; the server
  // decides whether to grant per-turn request capture.
  if (args["debug-dump"]) {
    const debugSecret = getEnv("DEBUG_SECRET");
    if (!debugSecret) {
      process.stderr.write("Error: --debug-dump requires TODOFORAI_DEBUG_SECRET\n");
      process.exit(2);
    }
    // Merge, don't clobber: ApiClient reads TODOFORAI_EXTRA_HEADERS per request.
    let extraHeaders: Record<string, string> = {};
    try { extraHeaders = JSON.parse(process.env.TODOFORAI_EXTRA_HEADERS || "{}"); } catch { /* malformed -> start fresh */ }
    extraHeaders["x-tfa-debug"] = debugSecret;
    process.env.TODOFORAI_EXTRA_HEADERS = JSON.stringify(extraHeaders);
  }

  const api = new ApiClient(apiUrl, apiKey, args["user-id"] as string | undefined);

  if (args["user-id"] && args.safe) {
    process.stderr.write("Error: --safe is not supported with --user-id\n");
    process.exit(2);
  }
  if (args["user-id"] && (args.resume || args.continue)) {
    process.stderr.write("Error: resume is not supported with --user-id\n");
    process.exit(2);
  }
  if (args["user-id"] && args.template && !args["no-watch"]) {
    process.stderr.write("Error: --user-id uses admin HTTP impersonation and requires --no-watch\n");
    process.exit(2);
  }

  // ── todo management subcommands (read-only on the bridge; no bridge spawn) ──
  if (positionals[0] === "status") {
    const [, todoId, status] = positionals;
    if (!todoId || !status) { printStatusHelp(); process.exit(2); }
    await api.updateTodoStatus(todoId, status);
    process.stderr.write(`${GREEN}✅ Status of ${todoId} set to ${status}${RESET}\n`);
    return;
  }
  if (positionals[0] === "delete") {
    const todoId = positionals[1];
    if (!todoId) { process.stderr.write(`${RED}Usage: tfa-cli delete <todo-id>${RESET}\n`); process.exit(2); }
    await api.deleteTodo(todoId);
    process.stderr.write(`${GREEN}✅ Deleted ${todoId}${RESET}\n`);
    return;
  }
  if (positionals[0] === "addmessage") {
    const [, todoId, ...rest] = positionals;
    const content = rest.join(" ") || (await readStdin());
    if (!todoId || !content) { process.stderr.write(`${RED}Usage: tfa-cli addmessage <todo-id> "content"${RESET}\n`); process.exit(2); }
    const todo = await api.getTodo(todoId);
    // getTodo only returns agentSettingsId; addMessage needs the full settings
    // (the API asserts id+name+…), so fetch them when not inlined.
    const agent = todo.agentSettings || await api.getAgentSettings(todo.agentSettingsId);
    const msg = await api.addMessage(todo.projectId, content, agent, todoId);
    if (args.json) console.log(JSON.stringify(msg, null, 2));
    else process.stderr.write(`${GREEN}✅ Message added to ${todoId}${RESET}\n`);
    return;
  }

  if (positionals[0] === "show" && positionals[1] === "list") {
    // Positional todo-id wins. Explicit `--project` walks every todo so an
    // agent can find instances in other chats. Bare `show list` in an agent
    // shell still means this todo — both env vars are set there.
    const explicitProject = !!(args.project as string);
    const todoId = positionals[2] || (!explicitProject ? (getEnv("TODO_ID") || cfgScope.data.last_todo_id) : undefined);
    const projectId = todoId ? undefined : ((args.project as string) || getEnv("PROJECT_ID") || cfgScope.data.default_project_id);
    if (!todoId && !projectId) {
      process.stderr.write(`${RED}Usage: tfa-cli show list [todo-id] [--project <id>] [--card <name>]${RESET}\n`);
      process.exit(2);
    }
    const { items } = await api.listShows({ todoId, projectId, card: args.card as string | undefined });
    if (args.json) { console.log(JSON.stringify(items, null, 2)); return; }
    if (items.length === 0) {
      process.stderr.write(`${DIM}No show blocks in ${todoId || `project ${projectId}`}${RESET}\n`);
      return;
    }
    for (const it of items) {
      const kind = it.url ? `url ${it.url}` : (it.mime || "");
      const card = it.cardRef ? ` card=${it.cardRef}` : "";
      const link = it.display === "link" ? " link" : "";
      console.log(`${it.ref}  ${it.title || it.filename || ""}  ${kind}${card}${link}`);
    }
    return;
  }

  // show rm <site-id>: take a shown file down (all versions). The site id is
  // printed by `show`; the bytes themselves are just `curl <url>`.
  if (positionals[0] === "show" && positionals[1] === "rm") {
    const id = positionals[2];
    if (!id) { process.stderr.write(`${RED}Usage: tfa-cli show rm <site-id>${RESET}\n`); process.exit(2); }
    await api.deleteSite(id);
    process.stderr.write(`${GREEN}✅ deleted ${id}${RESET}\n`);
    return;
  }

  if (positionals[0] === "show") {
    const [, filePath, todoArg] = positionals;
    // Inside an agent shell the todo is implicit (TODOFORAI_TODO_ID); otherwise
    // fall back to the last todo this CLI touched.
    const todoId = todoArg || getEnv("TODO_ID") || cfgScope.data.last_todo_id;
    if (!filePath || !todoId) { process.stderr.write(`${RED}Usage: tfa-cli show <file|-> [todo-id] [--title T] [--alias A] [--mime M] [--card <name>] [--link] [--site <id>]${RESET}\n`); process.exit(2); }

    // `-` reads the bytes from stdin so any producer can pipe straight in
    // (`make_chart | todoforai-cli show -`). The bytes are stored either way.
    let blob: Blob, name: string;
    if (filePath === "-") {
      blob = new Blob([await Bun.readableStreamToArrayBuffer(Bun.stdin.stream())]);
      if (blob.size === 0) { process.stderr.write(`${RED}No data on stdin${RESET}\n`); process.exit(1); }
      // --title is presentation metadata; it must not become the stored filename
      // (it would also silently drive mime detection). Use --mime for the type.
      name = "stdin";
    } else {
      const file = Bun.file(resolve(filePath));
      if (!(await file.exists())) { process.stderr.write(`${RED}File not found: ${filePath}${RESET}\n`); process.exit(1); }
      blob = file;
      name = path.basename(filePath);
    }

    const res = await api.showFile(todoId, blob, name, {
      title: args.title, alias: args.alias, mime: args.mime, card: args.card as string | undefined,
      display: args.link ? "link" : undefined,
      site: args.site as string | undefined,
    });
    if (args.json) console.log(JSON.stringify(res, null, 2));
    else console.log(res.url ? `${res.ref}  site=${res.siteId}  ${res.url}` : res.ref);
    return;
  }

  if (positionals[0] === "open") {
    const [, url, todoArg] = positionals;
    const todoId = todoArg || getEnv("TODO_ID") || cfgScope.data.last_todo_id;
    if (!url || !todoId) { process.stderr.write(`${RED}Usage: tfa-cli open <url> [todo-id]${RESET}\n`); process.exit(2); }
    const res = await api.showUrl(todoId, url, { title: args.title, alias: args.alias });
    if (args.json) console.log(JSON.stringify(res, null, 2));
    else console.log(res.ref);
    return;
  }

  if (positionals[0] === "recommend") {
    // Reference an existing registry template as a recommendation card on a project.
    // Templates are created by `todoregistry-cli create` (which prints the id).
    const templateId = (args.template as string) || positionals[1];
    if (!templateId) {
      process.stderr.write(`${RED}Usage: tfa-cli recommend --template <id> [--note "why"] [--priority high|medium|low] [--title "..."] [--group <slug> [--group-name "..."] [--group-description "..."]] [--project <id>]${RESET}\n`);
      process.stderr.write(`${DIM}Create a template first with: todoregistry-cli create --name ... --description ... --body @prompt.md${RESET}\n`);
      process.exit(2);
    }
    let projectId = (args.project as string) || getEnv("PROJECT_ID") || cfgScope.data.default_project_id;
    if (!projectId) {
      const projects = await api.listProjects();
      projectId = projects.find((p: any) => p.project?.isDefault)?.project?.id || projects[0]?.project?.id;
    }
    if (!projectId) { process.stderr.write(`${RED}No project found — pass --project <id>${RESET}\n`); process.exit(2); }

    const priority = args.priority as ("high" | "medium" | "low" | undefined);
    if (priority && !["high", "medium", "low"].includes(priority)) {
      process.stderr.write(`${RED}--priority must be high, medium, or low${RESET}\n`);
      process.exit(2);
    }
    const rec = await api.recommend({
      projectId,
      specId: templateId,
      ...(args.title ? { title: args.title as string } : {}),
      ...(args.note ? { note: args.note as string } : {}),
      ...(priority ? { priority } : {}),
      ...(args["business-context"] ? { businessContextId: args["business-context"] as string } : {}),
      ...(args.group ? { group: args.group as string } : {}),
      ...(args["group-name"] ? { groupName: args["group-name"] as string } : {}),
      ...(args["group-description"] ? { groupDescription: args["group-description"] as string } : {}),
    });
    if (args.json) console.log(JSON.stringify(rec, null, 2));
    else process.stderr.write(`${GREEN}✅ Recommended template ${templateId} on project ${projectId}${RESET}\n`);
    return;
  }

  if (positionals[0] === "claim" && positionals[1] === "mint") {
    // Mint single-use /claim/<token> links that fork a project you own into a
    // fresh anonymous account per recipient. `--seed` (or --project/default).
    let seedProjectId = (args.seed as string) || (args.project as string) || getEnv("PROJECT_ID") || cfgScope.data.default_project_id;
    if (!seedProjectId) {
      const projects = await api.listProjects();
      seedProjectId = projects.find((p: any) => p.project?.isDefault)?.project?.id || projects[0]?.project?.id;
    }
    if (!seedProjectId) { process.stderr.write(`${RED}Usage: tfa-cli claim mint --seed <projectId> [--emails a@x,b@y] [--ttl <sec>]${RESET}\n`); process.exit(2); }
    const emails = (args.emails as string | undefined)?.split(",").map((e) => e.trim()).filter(Boolean);
    let ttlSec: number | undefined;
    if (args.ttl !== undefined) {
      ttlSec = Number(args.ttl);
      if (!Number.isFinite(ttlSec)) { process.stderr.write(`${RED}--ttl must be a number (seconds)${RESET}\n`); process.exit(2); }
    }
    const res = await fetch(`${apiUrl}${restBasePath(apiKey)}/claims/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ seedProjectId, ...(emails?.length ? { emails } : {}), ...(ttlSec !== undefined ? { ttlSec } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) { process.stderr.write(`${RED}Mint failed: ${res.status} ${text}${RESET}\n`); process.exit(1); }
    const out = JSON.parse(text);
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else for (const l of out.links) process.stdout.write(`${l.email ? `${l.email}\t` : ""}${CYAN}${l.url}${RESET}\n`);
    return;
  }

  if (positionals[0] === "next") {
    let projectId = (args.project as string) || getEnv("PROJECT_ID") || cfgScope.data.default_project_id;
    if (!projectId) {
      const projects = await api.listProjects();
      projectId = projects.find((p: any) => p.project?.isDefault)?.project?.id || projects[0]?.project?.id;
    }
    if (!projectId) { process.stderr.write(`${RED}No project found — pass --project <id>${RESET}\n`); process.exit(2); }

    // Ask the Business Analyzer for fresh recommendation cards. `--direction` is a
    // free-text steer sent as a chat message into the project's ongoing analyzer chat.
    const direction = (args.direction as string) || positionals.slice(1).join(" ").trim() || undefined;
    const res = await fetch(`${apiUrl}${restBasePath(apiKey)}/projects/${projectId}/recommendations/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ projectId, ...(args["business-context"] ? { businessContextId: args["business-context"] } : {}), ...(direction ? { direction } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) { process.stderr.write(`${RED}Generate failed: ${res.status} ${text}${RESET}\n`); process.exit(1); }
    const out = JSON.parse(text);
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else process.stderr.write(`${GREEN}✅ Generating recommendations — analyzer todo ${out.todoId}${RESET}\n`);
    return;
  }

  if (args["list-agents"]) { await listAgentsCommand(api, { json: !!args.json, formatPath: formatPathWithTilde }); return; }

  if (args["list-models"]) {
    // Ids come back as `provider:openrouter-id` — copy-pasteable into --model.
    const ids = qualifiedModelIds(await api.listModels(), positionals[0]);
    if (args.json) console.log(JSON.stringify(ids, null, 2));
    else for (const id of ids) process.stderr.write(`${BRAND}${id}${RESET}\n`);
    return;
  }

  if (positionals[0] === "agent") { await agentCommand(api, positionals, args, formatPathWithTilde); return; }

  // ── list todos (read-only) ──
  if (positionals[0] === "list" || positionals[0] === "ls") {
    let defaultProjectId = (args.project as string) || getEnv("PROJECT_ID") || cfgScope.data.default_project_id;
    if (!defaultProjectId) {
      const projects = await api.listProjects();
      defaultProjectId = projects.find((p: any) => p.project?.isDefault)?.project?.id || projects[0]?.project?.id;
    }
    // Hand the raw post-`list` argv to the subcommand for its own parsing.
    const sub = process.argv.slice(process.argv.indexOf(positionals[0]) + 1);
    await listTodosCommand(api, defaultProjectId ?? undefined, sub);
    return;
  }

  // ── inspect mode (read-only, no logo/tips) ──
  // Syntax: --inspect <todoId>[@<slice>]
  //   <slice> = Python-style on messages, e.g. :1, -3:, 5:10, 7
  if (args.inspect !== undefined) {
    const raw = String(args.inspect);
    const at = raw.indexOf("@");
    const todoId = at < 0 ? raw : raw.slice(0, at);
    const slice = at < 0 ? undefined : raw.slice(at + 1);
    if (!todoId) {
      process.stderr.write(`${RED}Error: --inspect requires a todoId${RESET}\n`);
      process.exit(2);
    }
    const todo = await api.getTodo(todoId);
    if (args.json) {
      let messages = todo.messages || [];
      if (slice) {
        try { messages = applySlice(messages, slice); }
        catch (e: any) { process.stderr.write(`${RED}${e.message}${RESET}\n`); process.exit(2); }
      }
      const mode: InspectMode = args.debug ? "debug" : args.detailed ? "detailed" : "default";
      const format: InspectFormat = args["format-anthropic"] ? "anthropic" : "compact";
      process.stdout.write(JSON.stringify(toAnthropicShape(messages, mode, format), null, 2) + "\n");
      return;
    }
    const mode: InspectMode = args.debug ? "debug" : args.detailed ? "detailed" : "default";
    const format: InspectFormat = args["format-anthropic"] ? "anthropic" : "compact";
    printFullChat(todo, getFrontendUrl(apiUrl, todoId), slice, mode, format);
    return;
  }

  // ── logo ──
  if (process.stderr.isTTY) printLogo();

  // ── template mode ──
  if (args.template) {
    if (!args["no-bridge"] && !args["no-watch"]) await ensureBridgeRunning(apiUrl, apiKey);
    const templateId = args.template as string;

    // Fetch spec to show info
    const spec: RegistrySpec = await api.getRegistrySpec(templateId);
    process.stderr.write(`${DIM}Template:${RESET} ${BRAND}${spec.name}${RESET}\n`);
    if (spec.description) process.stderr.write(`${DIM}${spec.description}${RESET}\n`);

    // Resolve project — ignore a cached default the account can no longer access
    const projects = await api.listProjects();
    let projectId = (args.project as string) || getEnv("PROJECT_ID");
    if (!projectId) {
      const cached = cfgScope.data.default_project_id;
      projectId = (cached && projects.some((p: any) => getItemId(p) === cached) ? cached : null)
        || projects.find((p: any) => p.project?.isDefault)?.project?.id
        || projects[0]?.project?.id;
    }
    if (!projectId) { process.stderr.write("Error: No project found\n"); process.exit(1); }

    const todo = await api.startFromSpec(projectId, templateId, {
      ...(groupTag ? { groupTag } : {}),
      ...(groupName ? { groupName } : {}),
    });
    const todoId = todo.id;
    cfgScope.setLastTodoId(todoId);

    const frontendUrl = getFrontendUrl(apiUrl, todoId);

    if (args.json) {
      console.log(JSON.stringify({ ...todo, frontend_url: frontendUrl }, null, 2));
    } else if (args["no-watch"]) {
      // --no-watch: this is the whole output — confirm start on stdout for machine callers
      console.log(`created ${todoId}`);
    } else {
      process.stderr.write(`${DIM}TODO:${RESET} ${CYAN}${frontendUrl}${RESET}\n`);
    }

    if (!args["no-watch"]) {
      const ws = new FrontendWebSocket(apiUrl, apiKey);
      await ws.connect();
      const autoApprove = !!args["dangerously-skip-permissions"];
      let agent: any = todo.agentSettings || { id: todo.agentSettingsId };
      if (args["allow-all"]) {
        const perms = agent.permissions || { allow: [], ask: [], deny: [] };
        agent = { ...agent, permissions: { ...perms, allow: [...(perms.allow || []), "*:*"] } };
      }

      await watchTodo(ws, todoId, projectId, {
        json: !!args.json, autoApprove, agentSettings: agent,
      });

      if (!args["non-interactive"]) {
        process.stderr.write(`\n${"─".repeat(40)}\n`);
        await interactiveLoop(ws, api, todoId, projectId, agent, !!args.json, autoApprove, cfg);
      }

      await ws.close();
    }
    return;
  }

  // Validate if --safe
  if (args.safe) {
    const v = await api.validateApiKey();
    if (!v.valid) { process.stderr.write(`Error: ${v.error}\n`); process.exit(1); }
    process.stderr.write(`API key valid (user: ${v.userId})\n`);
  }

  // ── resume mode ──
  if (args.resume || args.continue) {
    if (!args["no-bridge"]) await ensureBridgeRunning(apiUrl, apiKey);
    const todoId = (args.resume as string) || cfgScope.data.last_todo_id;
    if (!todoId) { process.stderr.write("Error: No recent todo found\n"); process.exit(1); }

    const todo = await api.getTodo(todoId);
    const projectId = todo.projectId;
    // getTodo only returns agentSettingsId; addMessage needs the full settings (id+name+…),
    // so fetch them when the todo didn't inline them.
    const agent = todo.agentSettings || await api.getAgentSettings(todo.agentSettingsId);

    // Display existing messages
    for (const msg of todo.messages || []) {
      const role = msg.role === "user" ? `${CYAN}You${RESET}` : `${GREEN}AI${RESET}`;
      process.stderr.write(`${role}: ${(msg.content || "").slice(0, 200)}\n`);
    }

    process.stderr.write(`\n${"─".repeat(40)}\nResumed: ${CYAN}${getFrontendUrl(apiUrl, todoId)}${RESET}\n`);

    const ws = new FrontendWebSocket(apiUrl, apiKey);
    await ws.connect();

    // A prompt passed on resume (positional or stdin) is appended to the existing
    // todo and watched — same as the create path. Without it we'd just idle in the
    // interactive loop, so `-n` resume would detach having sent nothing.
    const autoApprove = !!args["dangerously-skip-permissions"];
    const followUp = positionals.length > 0 ? positionals.join(" ") : (process.stdin.isTTY ? "" : await readStdin());
    if (followUp) {
      cfg.addToHistory(followUp);
      await api.addMessage(projectId, followUp, agent, todoId);
      await watchTodo(ws, todoId, projectId, { json: !!args.json, autoApprove, agentSettings: agent });
    }
    if (!args["non-interactive"]) {
      await interactiveLoop(ws, api, todoId, projectId, agent, !!args.json, autoApprove, cfg);
    }
    await ws.close();
    return;
  }

  if (args["user-id"] && !args["no-watch"]) {
    process.stderr.write("Error: --user-id uses admin HTTP impersonation and requires --no-watch\n");
    process.exit(2);
  }

  // ── start independent work early ──
  const ws = args["no-watch"] ? null : new FrontendWebSocket(apiUrl, apiKey);
  const wsReady = ws ? ws.connect() : null;
  // --isolated replaces the persistent bridge with its own ephemeral one, so
  // never auto-spawn the daemon alongside it.
  const bridgeReady = !args["no-bridge"] && !args["no-watch"] && !args.isolated
    ? ensureBridgeRunning(apiUrl, apiKey)
    : null;
  // Ephemeral todo-scoped bridge (mayfly): the todoId is minted HERE so the
  // bridge can register under `mayfly-<todoId>` before the todo exists; the
  // create below then reuses the same id. Workspace = --path/cwd. While the
  // bridge lives, the backend scopes this todo's dispatches to EXACTLY it.
  const isolatedTodoId = args.isolated ? crypto.randomUUID() : undefined;
  const mayfly = isolatedTodoId
    ? await spawnMayflyBridge(apiUrl, isolatedTodoId, realpathSync(resolve((args.path as string) || ".")), { debug: !!args.debug, apiKey })
    : null;
  if (mayfly) process.stderr.write(`${DIM}Isolated bridge:${RESET} ${CYAN}mayfly-${isolatedTodoId}${RESET}\n`);

  // ── pre-resolve agent by --agent name or --path ──
  let preMatchedAgent: any = null;
  let agents: any[] | null = null;

  if (args.agent) {
    agents = await api.listAgentSettings();
    const { match, ambiguous } = resolveAgentMatch(agents, args.agent as string);
    if (ambiguous) {
      process.stderr.write(`Error: Ambiguous agent '${args.agent}' — ${ambiguous.length} matches. Re-run with the exact id:\n`);
      for (const a of ambiguous) process.stderr.write(`  ${getDisplayName(a)}  ${DIM}${getItemId(a)}${RESET}\n`);
      process.exit(1);
    }
    if (!match) {
      process.stderr.write(`Error: Agent '${args.agent}' not found\n`);
      process.exit(1);
    }
    preMatchedAgent = match;
    cfgScope.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
  } else {
    // Resolve from --path or cwd
    const pathArg = (args.path as string) || ".";
    const resolved = realpathSync(resolve(pathArg));
    const matches = await api.listAgentSettings({ workspacePath: resolved });
    if (matches.length > 0) {
      preMatchedAgent = matches[0];
      cfgScope.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
    } else if (args.path) {
      // Explicit --path with no match — auto-create
      process.stderr.write(`No agent found for '${formatPathWithTilde(resolved)}', creating one...\n`);
      try {
        preMatchedAgent = await autoCreateAgent(api, resolved);
        cfgScope.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
      } catch (e: any) {
        process.stderr.write(`Error: Failed to auto-create agent: ${e.message}\n`);
        process.exit(1);
      }
    }
  }

  if (preMatchedAgent) {
    const paths = getAgentWorkspacePaths(preMatchedAgent);
    const pathLabel = paths.length === 1 ? "Path" : "Paths";
    const pathStr = paths.length === 1 
      ? formatPathWithTilde(paths[0]) 
      : JSON.stringify(paths.map(formatPathWithTilde));
    const model = (args.model as string) || preMatchedAgent.model;
    const modelSuffix = model ? ` ${DIM}│ Model:${RESET} ${CYAN}${model}${RESET}` : "";
    process.stderr.write(
      `${DIM}Agent:${RESET} ${BRAND}${getDisplayName(preMatchedAgent)}${RESET} ${DIM}│ ${pathLabel}:${RESET} ${CYAN}${pathStr}${RESET}${modelSuffix}\n`,
    );
  }
  process.stderr.write(`${DIM}Tip: ${randomTip()}${RESET}\n`);

  // ── read content ──
  let content: string;
  if (positionals.length > 0) {
    content = positionals.join(" ");
  } else {
    content = await readStdin();
  }

  // ── select project + agent ──
  // Env inheritance: an agent shell exports TODOFORAI_PROJECT_ID for its todo's
  // project, so spun-off todos land in the SAME project by default instead of
  // whatever project this machine's config last cached. --project still wins.
  const envProjectId = getEnv("PROJECT_ID");
  const hasProject = args.project || envProjectId || cfgScope.data.default_project_id;
  const storedAgent = cfgScope.data.default_agent_settings;
  const hasAgent = preMatchedAgent || (storedAgent?.id && !args.agent);

  let projects: any[] | null = null;
  if (!hasProject || !hasAgent || args.safe || args.debug) {
    projects = await api.listProjects();
    if (!hasAgent && !agents) agents = await api.listAgentSettings();
  }

  // Select project
  let projectId: string;
  let projectName: string;
  if (args.project || envProjectId) {
    projectId = (args.project as string) || envProjectId;
    projectName = projectId;
    if (projects) {
      const match = projects.find((p: any) => getItemId(p) === projectId);
      if (match) projectName = getDisplayName(match);
    }
  } else if (cfgScope.data.default_project_id && !projects) {
    projectId = cfgScope.data.default_project_id;
    projectName = cfgScope.data.default_project_name || projectId;
  } else {
    const sel = await selectProject(
      projects!,
      cfgScope.data.default_project_id,
      (id, name) => cfgScope.setDefaultProject(id, name),
    );
    projectId = sel.id;
    projectName = sel.name;
  }

  // Select agent
  let agent: any;
  if (preMatchedAgent) {
    agent = preMatchedAgent;
  } else if (storedAgent?.id && !agents) {
    agent = storedAgent;
  } else {
    agent = await selectAgent(
      agents!,
      cfgScope.data.default_agent_name,
      (name, settings) => cfgScope.setDefaultAgent(name, settings),
    );
  }

  // The frontend socket must be connected to avoid missing early events, and
  // the local bridge must be online before the backend snapshots available devices.
  if (wsReady) await wsReady;
  if (bridgeReady) await bridgeReady;

  // ── create todo ──
  if (args.model) agent = { ...agent, model: args.model };
  if (args["raw-sysmsg"]) {
    const sysmsg = readFileSync(resolve(args["raw-sysmsg"] as string), "utf-8");
    agent = { ...agent, systemMessage: sysmsg, systemMessageMode: "raw" };
  }
  if (args["allow-all"]) {
    const perms = agent.permissions || { allow: [], ask: [], deny: [] };
    agent = { ...agent, permissions: { ...perms, allow: [...(perms.allow || []), "*:*"] } };
  }
  cfg.addToHistory(content);
  let todo: any;
  try {
    todo = await api.addMessage(projectId, content, agent, isolatedTodoId, undefined, undefined, groupTag || undefined, groupName);
  } catch (e: any) {
    // Cached default project may belong to another account or be deleted.
    // Only clear the cache when the cache actually picked the project — an
    // env-selected (TODOFORAI_PROJECT_ID) 403 is not the cache's fault.
    if (!args.project && !envProjectId && cfgScope.data.default_project_id === projectId && /failed: 403/.test(e.message || "")) {
      cfgScope.clearDefaultProject();
      process.stderr.write(`${RED}Not authorized for cached default project ${projectName} (${projectId}) — cleared it. Re-run to pick a project.${RESET}\n`);
      process.exit(1);
    }
    throw e;
  }
  const actualTodoId = todo.id || crypto.randomUUID();
  cfgScope.setLastTodoId(actualTodoId);

  const frontendUrl = getFrontendUrl(apiUrl, actualTodoId);

  if (args.json) {
    console.log(JSON.stringify({ ...todo, frontend_url: frontendUrl }, null, 2));
  } else if (!ws) {
    // --no-watch: this is the whole output — confirm start on stdout for machine callers
    console.log(`created ${actualTodoId}`);
  } else {
    process.stderr.write(`${DIM}TODO:${RESET} ${CYAN}${frontendUrl}${RESET}\n`);
  }

  // ── watch ──
  if (ws) {
    const autoApprove = !!args["dangerously-skip-permissions"];

    await watchTodo(ws, actualTodoId, projectId, {
      json: !!args.json,
      autoApprove,
      agentSettings: agent,
    });

    // ── interactive follow-up ──
    if (!args["non-interactive"]) {
      process.stderr.write(`\n${"─".repeat(40)}\n`);
      await interactiveLoop(ws, api, actualTodoId, projectId, agent, !!args.json, autoApprove, cfg);
    }

    await ws.close();
  }
  mayfly?.stop();
}

// Preserve any exit code set during the run (e.g. watchTodo on a non-success
// terminal status); `process.exit(0)` would mask a failed run as success.
// Under bun, process.exit() discards buffered pipe writes, truncating
// `list --json | jq` at 64 KiB. end(cb) is the only flush signal that's
// honest on both bun 1.3 and 1.4 (writableLength/needDrain report 0 while
// data is still buffered); finish() is terminal, so closing stdout is fine.
const finish = (code: number) => {
  process.exitCode = code;
  process.stdout.end(() => process.exit(code));
};
main().then(() => finish(process.exitCode ?? 0)).catch((e) => {
  process.stderr.write(`Error: ${e.message}\n`);
  finish(1);
});
