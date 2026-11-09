/** Agent resolution — workspace path matching and auto-creation */

import { realpathSync } from "fs";
import { resolve, basename } from "path";
import { ApiClient } from "@shared/api";
import { bridgeDeviceId } from "./ensure-bridge";

export function getAgentWorkspacePaths(agent: any): string[] {
  const paths: string[] = [];
  for (const ec of Object.values(agent.edgesMcpConfigs || {}) as any[]) {
    const tc = ec?.todoai_edge || ec?.todoai || {};
    paths.push(...(tc.workspacePaths || []));
  }
  for (const dc of Object.values(agent.devicesConfig || {}) as any[]) {
    paths.push(...(dc?.workspacePaths || []));
  }
  return paths;
}

export function findAgentByPath(agents: any[], path: string): any | null {
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

export async function autoCreateAgent(api: ApiClient, resolvedPath: string): Promise<any> {
  // An agent shell (dst_ token) may not wire workspaces.
  if (api.apiKey.startsWith("dst_")) {
    throw new Error("an agent shell cannot bind workspaces; pass --agent <name> or create the agent in the app");
  }
  // The CLI spawns a bridge, so prefer the local bridge device; fall back to the
  // single legacy edge for hosts that still run the edge daemon.
  const deviceId = bridgeDeviceId(api.apiUrl);
  let edgeId: string | undefined;
  if (!deviceId) {
    const edges = await api.listEdges();
    if (!Array.isArray(edges) || edges.length === 0) {
      throw new Error("No bridge device or edge available to configure workspace path");
    }
    if (edges.length > 1) {
      throw new Error("No local bridge device found and multiple legacy edges are available; choose an existing agent explicitly");
    }
    edgeId = edges[0].id;
  }
  // One idempotent server call: finds or creates + names + wires, so a failed step or
  // two concurrent launches can't leave orphan "<folder>" agents behind.
  try {
    const { agent } = await api.ensureAgentForWorkspace({ workspacePaths: [resolvedPath], deviceId, edgeId, name: basename(resolvedPath) || "default" });
    return agent;
  } catch (e: any) {
    const m = e?.message ?? "";
    if (/ 404 /.test(m) && !/(Device|Edge|User) not found/.test(m)) throw new Error(`this server (${api.apiUrl}) is too old to create workspace agents; update it or pass --agent <name>`);
    throw e;
  }
}
