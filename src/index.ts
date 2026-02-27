#!/usr/bin/env bun
/**
 * TODOforAI CLI (Bun) — Create and manage todos
 * Usage: todoai "prompt text" | echo "content" | todoai [options]
 */

import { parseArgs } from "util";
import { createInterface } from "readline";
import { realpathSync } from "fs";
import { resolve, basename } from "path";
import { homedir } from "os";

import { randomTip } from "./tips";
import { ApiClient } from "todoforai-edge/src/api";
import { FrontendWebSocket } from "todoforai-edge/src/frontend-ws";
import { normalizeApiUrl } from "todoforai-edge/src/config";

import { ConfigStore } from "./config";
import { printLogo } from "./logo";
import { selectProject, selectAgent, getDisplayName, getItemId } from "./select";
import { watchTodo } from "./watch";

// ── arg parsing ──────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://api.todofor.ai";

function getEnv(name: string): string {
  return process.env[`TODOFORAI_${name}`] || process.env[`TODO4AI_${name}`] || "";
}

function printUsage() {
  process.stderr.write(`
todoai — TODOforAI CLI (Bun)

Usage:
  todoai "prompt text"                  # Prompt as argument
  todoai -p "Quick task"               # Print mode (non-interactive)
  echo "content" | todoai              # Pipe from stdin
  todoai --path /my/project "Fix bug"  # Explicit workspace path
  todoai -c                            # Resume last todo
  todoai --resume <todo-id>            # Resume specific todo

Options:
  --path <dir>             Workspace path (default: cwd)
  --project <id>           Project ID
  --agent, -a <name>       Agent name (partial match)
  --api-url <url>          API URL
  --api-key <key>          API key
  --resume, -r [todo-id]   Resume existing todo
  --continue, -c           Continue most recent todo
  --print, -p              Non-interactive: run single message and exit
  --no-watch               Create todo and exit
  --json                   Output as JSON
  --safe                   Validate API key upfront
  --debug, -d              Debug output
  --show-config            Show config
  --set-defaults           Interactive defaults setup
  --set-default-api-url    Set default API URL
  --set-default-api-key    Set default API key
  --reset-config           Reset config file
  --help, -h               Show this help
`);
}

function parseCliArgs() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      path: { type: "string", default: "." },
      project: { type: "string" },
      agent: { type: "string", short: "a" },
      "api-url": { type: "string" },
      "api-key": { type: "string" },
      resume: { type: "string", short: "r" },
      continue: { type: "boolean", short: "c", default: false },
      print: { type: "boolean", short: "p", default: false },
      "no-watch": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      safe: { type: "boolean", default: false },
      debug: { type: "boolean", short: "d", default: false },
      "show-config": { type: "boolean", default: false },
      "set-defaults": { type: "boolean", default: false },
      "set-default-api-url": { type: "string" },
      "set-default-api-key": { type: "string" },
      "reset-config": { type: "boolean", default: false },
      "config-path": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  return { values, positionals };
}

// ── helpers ──────────────────────────────────────────────────────────

function formatPathWithTilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? path.replace(home, "~") : path;
}

function getAgentWorkspacePaths(agent: any): string[] {
  const paths: string[] = [];
  for (const ec of Object.values(agent.edgesMcpConfigs || {}) as any[]) {
    const tc = ec?.todoai_edge || ec?.todoai || {};
    paths.push(...(tc.workspacePaths || []));
  }
  return paths;
}

function findAgentByPath(agents: any[], path: string): any | null {
  const resolved = realpathSync(resolve(path));
  for (const agent of agents) {
    for (const wp of getAgentWorkspacePaths(agent)) {
      try {
        if (realpathSync(resolve(wp)) === resolved) return agent;
      } catch {}
    }
  }
  return null;
}

async function autoCreateAgent(api: ApiClient, resolvedPath: string, agents: any[]): Promise<any> {
  const folderName = basename(resolvedPath) || "default";

  // 1. Create agent
  const resp = await api.createAgent();
  const agentId = resp.id || resp.agentSettingsId;
  if (!agentId) throw new Error(`Failed to create agent: ${JSON.stringify(resp)}`);
  const agentSettingsId = resp.agentSettingsId || agentId;

  // 2. Set name
  await api.updateAgentSettings(agentId, agentSettingsId, { name: folderName });

  // 3. Find edge ID from existing agents or fetch /edges
  let edgeId: string | null = null;
  for (const a of agents) {
    const keys = Object.keys(a.edgesMcpConfigs || {});
    if (keys.length) { edgeId = keys[0]; break; }
  }
  if (!edgeId) {
    const edges = await api.listEdges();
    if (Array.isArray(edges) && edges.length) edgeId = edges[0].id;
  }
  if (!edgeId) throw new Error("No edge available to configure workspace path");

  // 4. Set workspace path
  await api.setAgentEdgeMcpConfig(agentId, agentSettingsId, edgeId, "todoai_edge", { workspacePaths: [resolvedPath] });

  // 5. Re-fetch full agent
  const allAgents = await api.listAgentSettings();
  const found = allAgents.find((a: any) => getItemId(a) === agentId);
  if (found) return found;

  // Fallback
  resp.name = folderName;
  resp.edgesMcpConfigs = { [edgeId]: { todoai_edge: { workspacePaths: [resolvedPath] } } };
  return resp;
}

function getFrontendUrl(apiUrl: string, projectId: string, todoId: string): string {
  if (apiUrl.includes("localhost:4000") || apiUrl.includes("127.0.0.1:4000")) {
    return `http://localhost:3000/${projectId}/${todoId}`;
  }
  return `https://todofor.ai/${projectId}/${todoId}`;
}

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.question(prompt, (ans) => {
      rl.close();
      res(ans.trim());
    });
  });
}

/** Raw-mode prompt with bracketed paste: multiline paste preserved, Enter submits.
 *  Returns { promise, cancel } — call cancel() to abort the prompt externally. */
function readMultiline(prompt: string): { promise: Promise<string>; cancel: () => void } {
  let cancelFn: () => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    const out = process.stderr;
    let buf = "";
    let cursor = 0; // cursor position within buf
    let pasting = false;
    let done = false;
    let screenRow = 0; // current terminal row relative to prompt start

    // Strip ANSI to compute visible prompt length
    const promptLen = prompt.replace(/\x1b\[[0-9;]*m/g, "").length;

    out.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    out.write("\x1b[?2004h"); // enable bracketed paste

    /** Compute terminal row (0-based from prompt start) for a buffer position.
     *  Matches terminal deferred-wrap behavior: cursor at exactly N*cols
     *  is on the last column of the current row, not column 0 of the next. */
    function rowOf(pos: number): number {
      const cols = process.stderr.columns || 80;
      const lines = buf.slice(0, pos).split("\n");
      let row = 0;
      for (let i = 0; i < lines.length; i++) {
        const len = (i === 0 ? promptLen : 0) + lines[i].length;
        if (i < lines.length - 1) {
          // Full logical line (followed by \n): occupies ceil(len/cols) rows
          row += len === 0 ? 1 : Math.ceil(len / cols);
        } else {
          // Cursor line: ceil(len/cols)-1 gives the 0-based row within
          // this logical line. At exact multiples of cols the cursor is
          // at the end of the row (deferred wrap), not on a new row.
          row += len > 0 ? Math.ceil(len / cols) - 1 : 0;
        }
      }
      return row;
    }

    /** Compute terminal column (0-based) for a buffer position.
     *  At an exact wrap boundary (linePos is nonzero multiple of cols),
     *  returns cols to indicate the cursor is past the last column
     *  (deferred wrap state). */
    function colOf(pos: number): number {
      const cols = process.stderr.columns || 80;
      const lastNl = buf.lastIndexOf("\n", pos - 1);
      const lineStart = lastNl + 1;
      const offset = lineStart === 0 ? promptLen : 0;
      const linePos = offset + (pos - lineStart);
      if (linePos > 0 && linePos % cols === 0) return cols;
      return linePos % cols;
    }

    /** Total terminal rows occupied by prompt + buffer content.
     *  Each logical line occupies ceil(len/cols) rows (minimum 1). */
    function totalRows(): number {
      const cols = process.stderr.columns || 80;
      const lines = buf.split("\n");
      let rows = 0;
      for (let i = 0; i < lines.length; i++) {
        const len = (i === 0 ? promptLen : 0) + lines[i].length;
        rows += len === 0 ? 1 : Math.ceil(len / cols);
      }
      return rows;
    }

    /** Full redraw from prompt start. */
    function redraw() {
      const cols = process.stderr.columns || 80;
      // Move to prompt start using tracked screen position
      out.write("\r");
      if (screenRow > 0) out.write(`\x1b[${screenRow}A`);
      out.write("\x1b[J"); // clear to end of screen
      out.write(prompt + buf.replace(/\n/g, "\r\n"));
      // Position cursor at target row/col.
      // rowOf/colOf match the terminal's deferred-wrap behavior, so the
      // end-of-content position is always totalRows()-1 (same as terminal).
      const targetRow = rowOf(cursor);
      const endRow = totalRows() - 1;
      const rowsBack = endRow - targetRow;
      const col = colOf(cursor);
      if (rowsBack > 0) out.write(`\x1b[${rowsBack}A`);
      if (col <= cols) {
        out.write("\r");
        if (col > 0 && col < cols) out.write(`\x1b[${col}C`);
        // col === cols: deferred wrap — move to last column explicitly
        if (col === cols) out.write(`\x1b[${cols}G`);
      }
      screenRow = targetRow;
    }

    function finish(cancelled: boolean) {
      if (done) return;
      done = true;
      // Move to end of content before exiting
      const rowsDown = totalRows() - 1 - screenRow;
      if (rowsDown > 0) out.write(`\x1b[${rowsDown}B`);
      out.write("\x1b[?2004l"); // disable bracketed paste
      out.write("\n");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      if (cancelled) reject(new Error("cancelled"));
      else resolve(buf.trim());
    }

    /** Find next word boundary to the right */
    function wordRight(): number {
      let p = cursor;
      while (p < buf.length && buf[p] === " ") p++;
      while (p < buf.length && buf[p] !== " ") p++;
      return p;
    }
    /** Find next word boundary to the left */
    function wordLeft(): number {
      let p = cursor;
      while (p > 0 && buf[p - 1] === " ") p--;
      while (p > 0 && buf[p - 1] !== " ") p--;
      return p;
    }
    /** Kill from cursor to end of line */
    function killToEnd() {
      buf = buf.slice(0, cursor);
      redraw();
    }
    /** Delete word backward (Ctrl+W) */
    function deleteWordBack() {
      const to = wordLeft();
      if (to === cursor) return;
      buf = buf.slice(0, to) + buf.slice(cursor);
      cursor = to;
      redraw();
    }

    /**
     * Parse a CSI sequence starting at chunk[i] where chunk[i] === '\x1b'.
     * Returns the new index i (after consuming the sequence).
     * CSI = ESC [ (params) (letter)  e.g. \x1b[1;5D
     */
    function handleCSI(chunk: string, start: number): number {
      let i = start + 1; // skip ESC
      if (i >= chunk.length || chunk[i] !== "[") {
        // Not CSI - skip ESC + one char
        if (i < chunk.length) i++;
        return i;
      }
      i++; // skip '['

      // Collect parameter bytes (digits, semicolons)
      let params = "";
      while (i < chunk.length && /[0-9;]/.test(chunk[i])) {
        params += chunk[i];
        i++;
      }
      // Final byte (letter or ~)
      const final = i < chunk.length ? chunk[i] : "";
      i++; // skip final byte

      // Parse modifier: "1;5" means modifier=5 (Ctrl), etc.
      const parts = params.split(";");
      const modifier = parts.length > 1 ? parseInt(parts[1]) : 0;
      const code = parts[0] || "";
      const ctrl = modifier === 5;

      switch (final) {
        case "D": // Left
          if (ctrl) { cursor = wordLeft(); redraw(); }
          else if (cursor > 0) { cursor--; redraw(); }
          break;
        case "C": // Right
          if (ctrl) { cursor = wordRight(); redraw(); }
          else if (cursor < buf.length) { cursor++; redraw(); }
          break;
        case "H": // Home
          cursor = 0; redraw();
          break;
        case "F": // End
          cursor = buf.length; redraw();
          break;
        case "~":
          if (code === "3" && cursor < buf.length) { // Delete
            buf = buf.slice(0, cursor) + buf.slice(cursor + 1);
            redraw();
          }
          break;
      }
      return i;
    }

    function onData(data: Buffer) {
      let s = data.toString("utf-8");
      while (s.length > 0 && !done) {
        if (pasting) {
          const end = s.indexOf("\x1b[201~");
          if (end >= 0) {
            const text = s.slice(0, end).replace(/\r\n?|\n/g, "\n"); // normalize newlines
            buf = buf.slice(0, cursor) + text + buf.slice(cursor);
            cursor += text.length;
            pasting = false;
            s = s.slice(end + 6);
            redraw();
          } else {
            const text = s.replace(/\r\n?|\n/g, "\n"); // normalize newlines
            buf = buf.slice(0, cursor) + text + buf.slice(cursor);
            cursor += text.length;
            s = "";
            redraw();
          }
        } else {
          const ps = s.indexOf("\x1b[200~");
          const chunk = ps >= 0 ? s.slice(0, ps) : s;

          for (let i = 0; i < chunk.length && !done; i++) {
            const c = chunk.charCodeAt(i);
            if (c === 0x03) { finish(true); return; }              // Ctrl+C
            if (c === 0x0d || c === 0x0a) { finish(false); return; } // Enter
            if (c === 0x17) { deleteWordBack(); }                   // Ctrl+W
            else if (c === 0x0b) { killToEnd(); }                   // Ctrl+K
            else if (c === 0x7f || c === 0x08) {                    // Backspace
              if (cursor > 0) {
                buf = buf.slice(0, cursor - 1) + buf.slice(cursor);
                cursor--;
                redraw();
              }
            } else if (c === 0x1b) {                                // ESC sequence
              // Alt+Enter (ESC + CR) → insert newline
              if (i + 1 < chunk.length && chunk.charCodeAt(i + 1) === 0x0d) {
                buf = buf.slice(0, cursor) + "\n" + buf.slice(cursor);
                cursor++;
                i++; // skip the \r
                redraw();
              } else {
                i = handleCSI(chunk, i) - 1; // -1 because for loop does i++
              }
            } else if (c === 0x01) {                                // Ctrl+A (Home)
              cursor = 0; redraw();
            } else if (c === 0x05) {                                // Ctrl+E (End)
              cursor = buf.length; redraw();
            } else if (c >= 0x20) {
              buf = buf.slice(0, cursor) + chunk[i] + buf.slice(cursor);
              cursor++;
              redraw();
            }
          }

          if (ps >= 0) { pasting = true; s = s.slice(ps + 6); }
          else s = "";
        }
      }
    }

    process.stdin.on("data", onData);

    cancelFn = () => finish(true);
  });
  return { promise, cancel: () => cancelFn() };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    try {
      const content = await readMultiline("\x1b[97mTODO>\x1b[0m ").promise;
      if (!content) { process.stderr.write("Error: Empty input\n"); process.exit(1); }
      return content;
    } catch {
      process.stderr.write("\nCancelled\n"); process.exit(1);
    }
  }
  // Piped
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString("utf-8").trim();
  if (!content) { process.stderr.write("Error: Empty input\n"); process.exit(1); }
  return content;
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

      const { promise: inputPromise, cancel: cancelInput } = readMultiline("\x1b[97mTODO>\x1b[0m ");

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
  // Handle SIGINT
  process.on("SIGINT", () => {
    process.stderr.write("\nCancelled by user (Ctrl+C)\n");
    process.exit(130);
  });

  const { values: args, positionals } = parseCliArgs();

  if (args.help) { printUsage(); process.exit(0); }

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
  if (args["set-default-api-url"]) { cfg.setDefaultApiUrl(args["set-default-api-url"] as string); console.log(`Default API URL set to: ${args["set-default-api-url"]}`); return; }
  if (args["set-default-api-key"]) { cfg.setDefaultApiKey(args["set-default-api-key"] as string); console.log("Default API key set"); return; }
  if (args["set-defaults"]) {
    // Interactive defaults — simple version
    const url = await readLine(`API URL [${cfg.data.default_api_url || DEFAULT_API_URL}]: `);
    if (url) cfg.setDefaultApiUrl(url);
    const key = await readLine("API Key: ");
    if (key) cfg.setDefaultApiKey(key);
    console.log("Defaults saved.");
    return;
  }

  // ── logo ──
  if (process.stderr.isTTY) printLogo();

  // ── resolve API client ──
  // Priority: CLI flag > config > env > default
  const apiUrl = normalizeApiUrl(
    (args["api-url"] as string) || cfg.data.default_api_url || getEnv("API_URL") || DEFAULT_API_URL,
  );
  const apiKey = (args["api-key"] as string) || cfg.data.default_api_key || getEnv("API_KEY") || "";

  if (!apiKey) {
    process.stderr.write("Error: No API key. Set via --api-key, TODOFORAI_API_KEY env, or --set-default-api-key\n");
    process.exit(1);
  }

  const api = new ApiClient(apiUrl, apiKey);

  // Validate if --safe
  if (args.safe) {
    const v = await api.validateApiKey();
    if (!v.valid) { process.stderr.write(`Error: ${v.error}\n`); process.exit(1); }
    process.stderr.write(`API key valid (user: ${v.userId})\n`);
  }

  // ── resume mode ──
  if (args.resume || args.continue) {
    const todoId = (args.resume as string) || cfg.data.last_todo_id;
    if (!todoId) { process.stderr.write("Error: No recent todo found\n"); process.exit(1); }

    const todo = await api.getTodo(todoId);
    const projectId = todo.projectId;
    const agent = todo.agentSettings || { name: "default" };

    // Display existing messages
    for (const msg of todo.messages || []) {
      const role = msg.role === "user" ? "\x1b[36mYou\x1b[0m" : "\x1b[32mAI\x1b[0m";
      process.stderr.write(`${role}: ${(msg.content || "").slice(0, 200)}\n`);
    }

    process.stderr.write(`\n${"─".repeat(40)}\nResumed todo: ${todoId}\n`);

    const ws = new FrontendWebSocket(apiUrl, apiKey);
    await ws.connect();

    await interactiveLoop(ws, api, todoId, projectId, agent, !!args.json, false);
    await ws.close();
    return;
  }

  // ── pre-resolve agent by --agent name or --path ──
  let preMatchedAgent: any = null;
  let agents: any[] | null = null;

  if (args.agent) {
    agents = await api.listAgentSettings();
    const name = (args.agent as string).toLowerCase();
    preMatchedAgent = agents.find((a: any) => getDisplayName(a).toLowerCase().includes(name));
    if (!preMatchedAgent) {
      process.stderr.write(`Error: Agent '${args.agent}' not found\nAvailable agents:\n`);
      for (const a of agents) process.stderr.write(`  - ${getDisplayName(a)}\n`);
      process.exit(1);
    }
    cfg.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
  } else if (args.path) {
    agents = await api.listAgentSettings();
    const found = findAgentByPath(agents, args.path as string);
    if (found) {
      preMatchedAgent = found;
      cfg.setDefaultAgent(getDisplayName(found), found);
    } else {
      const resolved = realpathSync(resolve(args.path as string));
      process.stderr.write(`No agent found for '${formatPathWithTilde(resolved)}', creating one...\n`);
      try {
        preMatchedAgent = await autoCreateAgent(api, resolved, agents);
        cfg.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
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
    process.stderr.write(
      `\x1b[90mAgent:\x1b[0m \x1b[38;2;249;110;46m${getDisplayName(preMatchedAgent)}\x1b[0m \x1b[90m│ ${pathLabel}:\x1b[0m \x1b[36m${pathStr}\x1b[0m\n`,
    );
  }
  process.stderr.write(`\x1b[90mTip: ${randomTip()}\x1b[0m\n`);

  // ── read content ──
  let content: string;
  if (positionals.length > 0) {
    content = positionals.join(" ");
  } else {
    content = await readStdin();
  }

  // ── select project + agent ──
  const hasProject = args.project || cfg.data.default_project_id;
  const storedAgent = cfg.data.default_agent_settings;
  const hasAgent = preMatchedAgent || (storedAgent?.id && !args.agent);

  let projects: any[] | null = null;
  if (!hasProject || !hasAgent || args.safe || args.debug) {
    projects = await api.listProjects();
    if (!agents) agents = await api.listAgentSettings();
  }

  // Select project
  let projectId: string;
  let projectName: string;
  if (args.project) {
    projectId = args.project as string;
    projectName = projectId;
    if (projects) {
      const match = projects.find((p: any) => getItemId(p) === projectId);
      if (match) projectName = getDisplayName(match);
    }
  } else if (cfg.data.default_project_id && !projects) {
    projectId = cfg.data.default_project_id;
    projectName = cfg.data.default_project_name || projectId;
  } else {
    const sel = await selectProject(
      projects!,
      cfg.data.default_project_id,
      (id, name) => cfg.setDefaultProject(id, name),
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
      cfg.data.default_agent_name,
      (name, settings) => cfg.setDefaultAgent(name, settings),
    );
  }

  // ── create todo ──
  const todo = await api.addMessage(projectId, content, agent);
  const actualTodoId = todo.id || crypto.randomUUID();
  cfg.data.last_todo_id = actualTodoId;
  cfg.save();

  const frontendUrl = getFrontendUrl(apiUrl, projectId, actualTodoId);

  if (args.json) {
    console.log(JSON.stringify({ ...todo, frontend_url: frontendUrl }, null, 2));
  } else {
    process.stderr.write(`\x1b[90mTODO:\x1b[0m \x1b[36m${frontendUrl}\x1b[0m\n`);
  }

  // ── watch ──
  if (!args["no-watch"]) {
    const ws = new FrontendWebSocket(apiUrl, apiKey);
    await ws.connect();

    await watchTodo(ws, actualTodoId, projectId, {
      json: !!args.json,
      autoApprove: false,
      agentSettings: agent,
    });

    // ── interactive follow-up ──
    if (!args.print) {
      process.stderr.write(`\n${"─".repeat(40)}\n`);
      await interactiveLoop(ws, api, actualTodoId, projectId, agent, !!args.json, false);
    }

    await ws.close();
  }
}

main().catch((e) => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
