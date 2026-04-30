/** `--list-agents` handler — prints agents (name, model, id, workspace paths). */

import type { ApiClient } from "@todoforai/edge/src/api";
import { getAgentWorkspacePaths } from "./agent";
import { getDisplayName, getItemId } from "./select";
import { BRAND, CYAN, DIM, RESET } from "./colors";

export async function listAgentsCommand(
  api: ApiClient,
  opts: { json?: boolean; formatPath: (p: string) => string },
) {
  const agents = await api.listAgentSettings();
  if (opts.json) { console.log(JSON.stringify(agents, null, 2)); return; }
  if (!agents.length) { process.stderr.write("No agents found.\n"); return; }

  const rows = agents.map((a: any) => ({
    name: getDisplayName(a),
    id: getItemId(a),
    model: a.model || "",
    paths: getAgentWorkspacePaths(a).map(opts.formatPath),
  }));
  const nameW = Math.max(4, ...rows.map(r => r.name.length));
  const modelW = Math.max(5, ...rows.map(r => r.model.length));
  process.stderr.write(`${DIM}${"NAME".padEnd(nameW)}  ${"MODEL".padEnd(modelW)}  ID${" ".repeat(34)}PATHS${RESET}\n`);
  for (const r of rows) {
    process.stderr.write(`${BRAND}${r.name.padEnd(nameW)}${RESET}  ${CYAN}${r.model.padEnd(modelW)}${RESET}  ${DIM}${r.id}${RESET}  ${r.paths.join(", ")}\n`);
  }
}
