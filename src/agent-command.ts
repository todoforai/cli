/** `agent` subcommand — inspect and update agent settings (model, etc.). */

import type { ApiClient } from "@todoforai/edge/src/api";
import { getAgentWorkspacePaths } from "./agent";
import { listAgentsCommand } from "./list-agents";
import { getDisplayName, getItemId, resolveAgentMatch } from "./select";
import { BRAND, CYAN, DIM, GREEN, RED, RESET } from "./colors";

export function printAgentHelp() {
  process.stderr.write(`
todoai agent — inspect and update agent settings

Usage:
  todoai agent list                            List agents (name, model, id, paths)
  todoai agent get <agent>                     Show a single agent's settings
  todoai agent update <agent> <field=value>…   Update one or more settings

<agent> is a name or id (unique partial name also works).
Fields map directly to agent settings; values are parsed as JSON when possible
(numbers, booleans), otherwise treated as strings. Common fields:
  model           e.g. claude  |  anthropic:anthropic/claude-opus-4.8
                  ('claude' is the rolling alias → latest Claude Opus)
  systemMessage   freeform prompt text (alias: sysmsg)
  temperature     number, e.g. 0.7
  thinkingLevel   low | medium | high | xhigh | max
  name            agent display name

Examples:
  todoai agent update <agent> model=claude
  todoai agent update <agent> model=anthropic:anthropic/claude-opus-4.8 temperature=0.5
  todoai agent update <agent> sysmsg="You are a terse video editor."
`);
}

/** Short field aliases → canonical agent-settings keys. */
const FIELD_ALIASES: Record<string, string> = {
  sysmsg: "systemMessage",
  prompt: "systemMessage",
  temp: "temperature",
  thinking: "thinkingLevel",
};

/** "field=value" → [canonicalKey, typed value (JSON when parseable, else string)]. */
function parseAssignment(arg: string): [string, any] {
  const eq = arg.indexOf("=");
  if (eq < 1) { process.stderr.write(`${RED}Invalid field assignment '${arg}', expected field=value${RESET}\n`); process.exit(2); }
  const rawKey = arg.slice(0, eq);
  const key = FIELD_ALIASES[rawKey] || rawKey;
  const raw = arg.slice(eq + 1);
  try { return [key, JSON.parse(raw)]; } catch { return [key, raw]; }
}

/** Resolve an agent by exact id, exact name, prefix, word-boundary, then substring. */
function resolveAgent(agents: any[], query: string): any {
  const { match, ambiguous } = resolveAgentMatch(agents, query);
  if (match) return match;
  if (ambiguous) {
    process.stderr.write(`${RED}Ambiguous agent '${query}' — ${ambiguous.length} matches. Re-run with the exact id:${RESET}\n`);
    for (const a of ambiguous) process.stderr.write(`  ${getDisplayName(a)}  ${DIM}${getItemId(a)}${RESET}\n`);
    process.exit(2);
  }
  process.stderr.write(`${RED}No agent matching '${query}'${RESET}\n`);
  process.exit(2);
}

export async function agentCommand(
  api: ApiClient,
  positionals: string[],
  args: Record<string, any>,
  formatPath: (p: string) => string,
) {
  const sub = positionals[1];

  if (!sub || sub === "list" || sub === "ls") {
    await listAgentsCommand(api, { json: !!args.json, formatPath });
    return;
  }

  if (sub === "get") {
    const agents = await api.listAgentSettings();
    const agent = resolveAgent(agents, positionals[2] || "");
    if (args.json) { console.log(JSON.stringify(agent, null, 2)); return; }
    process.stderr.write(`${BRAND}${getDisplayName(agent)}${RESET}  ${DIM}${getItemId(agent)}${RESET}\n`);
    process.stderr.write(`  ${DIM}model:${RESET} ${CYAN}${agent.model || "(default)"}${RESET}\n`);
    const paths = getAgentWorkspacePaths(agent).map(formatPath);
    if (paths.length) process.stderr.write(`  ${DIM}paths:${RESET} ${paths.join(", ")}\n`);
    return;
  }

  if (sub === "update") {
    const query = positionals[2];
    const assignments = positionals.slice(3);
    if (!query || !assignments.length) { process.stderr.write(`${RED}Usage: todoai agent update <name|id> <field=value>…${RESET}\n`); process.exit(2); }
    const updates = Object.fromEntries(assignments.map(parseAssignment));
    const agents = await api.listAgentSettings();
    const agent = resolveAgent(agents, query);
    const id = getItemId(agent);
    const updated = await api.updateAgentSettings(id, id, updates);
    if (args.json) { console.log(JSON.stringify(updated, null, 2)); return; }
    const summary = Object.keys(updates).map((k) => `${k}=${JSON.stringify((updated as any)[k])}`).join(" ");
    process.stderr.write(`${GREEN}✅ ${getDisplayName(agent)} updated: ${summary}${RESET}\n`);
    return;
  }

  process.stderr.write(`${RED}Unknown 'agent' subcommand: ${sub}${RESET}\n`);
  printAgentHelp();
  process.exit(2);
}
