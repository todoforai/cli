/** `connections` — everything the user has live right now, grouped by client (GET /connections). */

import type { ApiClient } from "@shared/api";
import { BOLD, CYAN, DIM, RESET } from "./colors";

type Session = { kind: string; id: string; connectedAt?: number; lastActivityAt?: number; todoId?: string; detail?: string };
type Client = { id: string; kind: string; name: string; deviceType?: string; sessions: Session[] };

export function printConnectionsHelp() {
  process.stderr.write(`
tfa-cli connections — what you have connected right now

Usage:
  tfa-cli connections [--json]

Grouped by client (a browser, the phone app, a machine), each with its live sessions:
  tab / app / cli     web tabs, the mobile/desktop app, CLI watchers (session id = frontendId)
  bridge              a paired machine or the cloud VM (mayfly-bridge: an isolated run)
  extension / cdp     the Chrome extension and agents driving it over CDP
  embedded-browser    a todo's in-page browser
  phone               a phone shared for agent control (ADB)
Snapshot from the backend instance that answers (normally all your connections live there).
`);
}

/** Names and todo titles come from clients: drop terminal control characters before printing. */
const clean = (v?: string) => (v ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

const ago = (t?: number) => {
  if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

export async function connectionsCommand(api: ApiClient, args: Record<string, any>) {
  const data = await api.listConnections() as { instance: string; clients: Client[] };
  if (args.json) { console.log(JSON.stringify(data)); return; }
  if (!data.clients.length) { process.stderr.write(`${DIM}Nothing connected${RESET}\n`); return; }
  for (const c of data.clients) {
    console.log(`${BOLD}${clean(c.name)}${RESET} ${DIM}${clean(c.deviceType ?? c.kind)} · ${clean(c.id)}${RESET}`);
    for (const s of c.sessions) {
      const since = s.connectedAt ? ` ${DIM}up ${ago(s.connectedAt)}${RESET}` : "";
      const todo = s.todoId ? ` ${CYAN}${clean(s.todoId).slice(0, 8)}${RESET}` : "";
      const detail = s.detail ? ` ${DIM}${clean(s.detail)}${RESET}` : "";
      console.log(`  ${clean(s.kind).padEnd(16)} ${clean(s.id)}${since}${todo}${detail}`);
    }
  }
  process.stderr.write(`${DIM}${data.clients.length} client(s) · ${data.clients.reduce((n, c) => n + c.sessions.length, 0)} session(s) · ${data.instance}${RESET}\n`);
}
