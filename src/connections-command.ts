/** `connections` — everything the user has live right now, grouped by host machine (GET /connections). */

import type { ApiClient } from "@shared/api";
import { BOLD, CYAN, DIM, RESET } from "./colors";

type Session = { kind: string; id: string; connectedAt?: number; lastActivityAt?: number; todoId?: string; detail?: string };
type Client = {
  id: string;
  kind: string;
  name: string;
  deviceType?: string;
  hostDeviceId?: string;
  hostDeviceName?: string;
  hostMatch?: "confirmed" | "exact" | "probable";
  browserDeviceId?: string;
  sessions: Session[];
};

export function printConnectionsHelp() {
  process.stderr.write(`
tfa-cli connections — what you have connected right now

Usage:
  tfa-cli connections [--json]

Grouped by host machine (PC / Cloud VM), with its live bridge, extensions, browser tabs,
desktop apps and embedded browsers underneath, followed by phones and unmatched clients:
  bridge / mayfly-bridge   a paired machine or the cloud VM (mayfly-bridge: an isolated run)
  extension / cdp          the Chrome extension and agents driving it over CDP
  tab / app / cli          web tabs, the desktop/mobile app, CLI watchers (id = frontendId)
  embedded-browser         a todo's in-page browser
  phone                    a phone shared for agent control (ADB)
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

const CHILD_ORDER: Record<string, number> = { browser: 0, web: 1, tauri: 2, "embedded-browser": 3, cli: 4, mobile: 5 };

function printSessions(sessions: Session[], pad: string) {
  for (const s of sessions) {
    const since = s.connectedAt ? ` ${DIM}up ${ago(s.connectedAt)}${RESET}` : "";
    const todo = s.todoId ? ` ${CYAN}${clean(s.todoId).slice(0, 8)}${RESET}` : "";
    const detail = s.detail ? ` ${DIM}${clean(s.detail)}${RESET}` : "";
    console.log(`${pad}${clean(s.kind).padEnd(16)} ${clean(s.id)}${since}${todo}${detail}`);
  }
}

function printChild(c: Client, browserNames: Map<string, string>, pad: string) {
  const tags = [clean(c.deviceType ?? c.kind)];
  const ext = c.browserDeviceId ? browserNames.get(c.browserDeviceId) : undefined;
  if (ext) tags.push(`in ${clean(ext)}`);
  if (c.hostMatch === "probable") tags.push("~probable");
  console.log(`${pad}${BOLD}${clean(c.name)}${RESET} ${DIM}${tags.join(" · ")}${RESET}`);
  printSessions(c.sessions, `${pad}  `);
}

export async function connectionsCommand(api: ApiClient, args: Record<string, any>) {
  const data = await api.listConnections() as { instance: string; thisHostDeviceId?: string; clients: Client[] };
  if (args.json) { console.log(JSON.stringify(data)); return; }
  if (!data.clients.length) { process.stderr.write(`${DIM}Nothing connected${RESET}\n`); return; }

  const hosts = new Map<string, { id: string; name: string; deviceType?: string; machine?: Client; children: Client[] }>();
  const phones: Client[] = [];
  const other: Client[] = [];
  const browserNames = new Map<string, string>();
  for (const c of data.clients) {
    if (c.kind === "machine") hosts.set(c.id, { id: c.id, name: c.name, deviceType: c.deviceType, machine: c, children: [] });
    else if (c.kind === "browser") browserNames.set(c.id, c.name);
  }
  for (const c of data.clients) {
    if (c.kind === "machine") continue;
    if (c.kind === "phone") { phones.push(c); continue; }
    if (c.hostDeviceId) {
      let h = hosts.get(c.hostDeviceId);
      if (!h) hosts.set(c.hostDeviceId, h = { id: c.hostDeviceId, name: c.hostDeviceName ?? c.hostDeviceId, children: [] });
      h.children.push(c);
    } else other.push(c);
  }

  for (const h of hosts.values()) {
    const meta = [h.deviceType, h.machine?.sessions[0]?.detail, !h.machine ? "bridge offline" : undefined, h.id === data.thisHostDeviceId ? "this machine" : undefined].filter(Boolean).map(clean).join(" · ");
    console.log(`${BOLD}${clean(h.name)}${RESET} ${DIM}${meta}${RESET}`);
    if (h.machine) printSessions(h.machine.sessions, "  ");
    h.children.sort((a, b) => (CHILD_ORDER[a.kind] ?? 9) - (CHILD_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name));
    for (const c of h.children) printChild(c, browserNames, "  ");
  }
  for (const p of phones) {
    console.log(`${BOLD}${clean(p.name)}${RESET} ${DIM}phone · ${clean(p.id)}${RESET}`);
    printSessions(p.sessions, "  ");
  }
  if (other.length) {
    console.log(`${BOLD}Other${RESET} ${DIM}host unknown${RESET}`);
    for (const c of other) printChild(c, browserNames, "  ");
  }
  process.stderr.write(`${DIM}${data.clients.length} client(s) · ${data.clients.reduce((n, c) => n + c.sessions.length, 0)} session(s) · ${data.instance}${RESET}\n`);
}
