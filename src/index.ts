#!/usr/bin/env bun
/**
 * TODOforAI CLI (Bun) — Create and manage todos
 * Usage: todoai "prompt text" | echo "content" | todoai [options]
 */

import { parseArgs } from "util";
import { createInterface } from "readline";
import { realpathSync } from "fs";
import { resolve, basename } from "path";

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
  --timeout <sec>          Watch timeout (default: 300)
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
      timeout: { type: "string", default: "300" },
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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    try {
      const content = await readLine("TODO> ");
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
  timeout: number,
  json: boolean,
  autoApprove: boolean,
) {
  while (true) {
    try {
      const input = await readLine("TODO> ");
      if (!input) continue;
      if (["/exit", "/quit", "/q", "q", "exit"].includes(input)) break;
      if (["/help", "?"].includes(input)) {
        process.stderr.write("  /exit, /quit, /q  - quit\n  /help, ?          - show help\n");
        continue;
      }
      process.stderr.write("─".repeat(40) + "\n");
      await api.addMessage(projectId, input, agent, todoId);
      await watchTodo(ws, todoId, projectId, timeout, {
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
    console.log(`Config file: ${cfg.path}`);
    console.log(JSON.stringify(cfg.data, null, 2));
    return;
  }
  if (args["reset-config"]) {
    const { existsSync, unlinkSync } = await import("fs");
    if (existsSync(cfg.path)) { unlinkSync(cfg.path); console.log(`Configuration reset: ${cfg.path}`); }
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

    const timeout = parseInt(args.timeout as string) || 300;
    await interactiveLoop(ws, api, todoId, projectId, agent, timeout, !!args.json, false);
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
    }
  }

  if (preMatchedAgent) {
    process.stderr.write(
      `AgentSettings: ${getDisplayName(preMatchedAgent)} Paths: ${JSON.stringify(getAgentWorkspacePaths(preMatchedAgent))}\n`,
    );
  }

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
  process.stderr.write("\nCreating TODO...\n");
  const todo = await api.addMessage(projectId, content, agent);
  const actualTodoId = todo.id || crypto.randomUUID();
  cfg.data.last_todo_id = actualTodoId;
  cfg.save();

  const frontendUrl = getFrontendUrl(apiUrl, projectId, actualTodoId);

  if (args.json) {
    console.log(JSON.stringify({ ...todo, frontend_url: frontendUrl }, null, 2));
  } else {
    process.stderr.write(`TODO created: ${frontendUrl}\n`);
  }

  // ── watch ──
  const timeout = parseInt(args.timeout as string) || 300;

  if (!args["no-watch"]) {
    const ws = new FrontendWebSocket(apiUrl, apiKey);
    await ws.connect();

    await watchTodo(ws, actualTodoId, projectId, timeout, {
      json: !!args.json,
      autoApprove: false,
      agentSettings: agent,
    });

    // ── interactive follow-up ──
    if (!args.print) {
      process.stderr.write(`\n${"─".repeat(40)}\n`);
      await interactiveLoop(ws, api, actualTodoId, projectId, agent, timeout, !!args.json, false);
    }

    await ws.close();
  }
}

main().catch((e) => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
