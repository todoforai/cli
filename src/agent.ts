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
  const folderName = basename(resolvedPath) || "default";
  // An agent shell (dst_ token) may create agents but not wire or delete them, so
  // every call would leave one more unwired agent behind.
  if (api.apiKey.startsWith("dst_")) {
    throw new Error("an agent shell cannot bind workspaces; pass --agent <name> or create the agent in the app");
  }

  // Resolve where the workspace will be wired BEFORE creating anything: an agent
  // created first and left unwired never matches this path again, so every
  // retry used to leave another orphan "<folder>" agent in the user's list.
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

  const resp = await api.createAgent();
  const agentId = resp.id || resp.agentSettingsId;
  if (!agentId) throw new Error(`Failed to create agent: ${JSON.stringify(resp)}`);
  const agentSettingsId = resp.agentSettingsId || agentId;

  try {
    await api.updateAgentSettings(agentId, agentSettingsId, { name: folderName });
    if (deviceId) {
      await api.setAgentDeviceConfig(agentId, agentSettingsId, deviceId, { workspacePaths: [resolvedPath] });
      resp.devicesConfig = { [deviceId]: { workspacePaths: [resolvedPath] } };
    } else {
      await api.setAgentEdgeMcpConfig(agentId, agentSettingsId, edgeId!, "todoai_edge", { workspacePaths: [resolvedPath] });
      resp.edgesMcpConfigs = { [edgeId!]: { todoai_edge: { workspacePaths: [resolvedPath] } } };
    }
  } catch (e) {
    await api.deleteAgentSettings(agentSettingsId).catch((d: any) => {
      process.stderr.write(`Warning: could not remove half-created agent ${agentSettingsId}: ${d?.message ?? d}\n`);
    });
    throw e;
  }

  const matches = await api.listAgentSettings({ workspacePath: resolvedPath });
  if (matches.length) return matches[0];
  resp.name = folderName;
  return resp;
}
