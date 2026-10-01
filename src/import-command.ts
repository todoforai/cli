/** `tfa-cli import` — bring Claude Code / Codex sessions into TODOforAI as finished todos.
 *
 * Runs where the session files live (the user's machine, i.e. the bridge host): parse
 * locally, send only the flattened transcript to `POST /todos/import`. The backend keys
 * on (source path, sha256), so re-running is idempotent and picks up changed sessions.
 *
 *   tfa-cli import detect [--json]            what is importable on this machine
 *   tfa-cli import [claude|codex] [flags]     import sessions (default: both sources)
 */
import { parseArgs } from "util";
import { statSync } from "fs";
import { basename, dirname, resolve } from "path";
import type { ApiClient } from "@shared/api";
import { CYAN, DIM, GREEN, YELLOW, RED, RESET } from "./colors";
import { type ExternalSession } from "./import/common";
import { claudeHome, listClaudeSessionFiles, parseClaudeSession } from "./import/claude";
import { codexHome, listCodexSessionFiles, parseCodexSession, readCodexTitles } from "./import/codex";

/** Same defaults as Codex's importer: recent sessions only, bounded count. */
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_COUNT = 50;

type SourceKind = "claude" | "codex";
/** Global value-taking flags the main parser owns (see args.ts). */
const GLOBAL_VALUE_FLAGS = new Set(["--api-key", "--api-url", "--user-id", "--model", "--agent", "-a"]);
const SOURCES: SourceKind[] = ["claude", "codex"];

export function printImportHelp() {
  process.stderr.write(`
tfa-cli import — import Claude Code / Codex sessions as todos

Usage:
  tfa-cli import detect [--json]
  tfa-cli import [claude|codex] [flags]

Flags:
      --project <id>      Target project (default: current default project)
      --agent-id <id>     Agent for every imported todo (default: match the session cwd, else your default agent)
      --days <n>          Only sessions modified in the last n days (default: ${DEFAULT_MAX_AGE_DAYS}; 0 = all)
      --limit <n>         Max sessions per source, newest first (default: ${DEFAULT_MAX_COUNT})
      --path <file>       Import exactly this session file (repeatable)
      --dry-run           Parse and list, write nothing
      --json              Machine-readable output
  -h, --help              Show this help

Sources on this machine:
  Claude Code  ${claudeHome()}/projects/*/*.jsonl
  Codex        ${codexHome()}/sessions/**/rollout-*.jsonl
`);
}

interface Detected { kind: SourceKind; home: string; sessions: number; recent: number; }

function detect(days: number): Detected[] {
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const count = (kind: SourceKind, home: string, files: string[]) => {
    const parsed = files.map(f => safeParse(kind, f)).filter((s): s is ExternalSession => !!s);
    return { kind, home, sessions: parsed.length, recent: parsed.filter(s => s.modifiedAt >= cutoff).length };
  };
  return [count("claude", claudeHome(), listClaudeSessionFiles()), count("codex", codexHome(), listCodexSessionFiles())];
}

let codexTitles: Map<string, string> | undefined;
function safeParse(kind: SourceKind, file: string): ExternalSession | null {
  try { return kind === "claude" ? parseClaudeSession(file) : parseCodexSession(file, codexTitles ??= readCodexTitles()); } catch { return null; }
}

/** Explicit `--path` files: `kind` wins when one source was named, else guessed from the filename. */
function collectExplicit(kind: SourceKind | undefined, explicit: string[], skipped: string[]): ExternalSession[] {
  return explicit.map(p => {
    const file = resolve(p);
    const k: SourceKind = kind ?? (basename(file).startsWith("rollout-") ? "codex" : "claude");
    const s = safeParse(k, file);
    if (!s) skipped.push(file);
    return s;
  }).filter((s): s is ExternalSession => !!s);
}

/** Newest `limit` sessions per source modified within `days` (mtime-filtered before parsing). */
function collect(kinds: SourceKind[], days: number, limit: number): ExternalSession[] {
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const out: ExternalSession[] = [];
  for (const kind of kinds) {
    const files = kind === "claude" ? listClaudeSessionFiles() : listCodexSessionFiles();
    const sessions = files.map(f => ({ f, mtime: statSync(f).mtimeMs }))
      .filter(x => x.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime)
      .map(x => safeParse(kind, x.f))
      .filter((s): s is ExternalSession => !!s)
      .slice(0, limit);
    out.push(...sessions);
  }
  return out;
}

/** Agent whose workspace contains the session cwd (walking up), else `fallback`. Cached per directory. */
async function agentForCwd(api: ApiClient, cwd: string, fallback: string, cache: Map<string, string>): Promise<string> {
  let dir = cwd;
  while (true) {
    const hit = cache.get(dir);
    if (hit) return hit;
    const matches = await api.listAgentSettings({ workspacePath: dir }).catch(() => []);
    if (matches.length) { cache.set(dir, matches[0].id); return matches[0].id; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(cwd, fallback);
  return fallback;
}

/** True when the invocation needs no backend (detect / --dry-run / --help): run it before auth. */
export function importIsLocalOnly(argv = process.argv): boolean {
  const sub = argv.slice(argv.indexOf("import") + 1);
  return sub.includes("--help") || sub.includes("-h") || sub.includes("--dry-run") || sub[0] === "detect";
}

export async function importCommand(api: ApiClient | null, scopedProject: string | undefined, defaultAgentId: string | undefined) {
  // Re-parse only this command's flags; global ones (--api-key, --api-url, …) were
  // already consumed by the main parser and would otherwise read as positionals here.
  const sub = process.argv.slice(process.argv.indexOf("import") + 1).filter((tok, i, all) =>
    !GLOBAL_VALUE_FLAGS.has(tok) && !GLOBAL_VALUE_FLAGS.has(all[i - 1] ?? ""));
  const { values: v, positionals: rest } = parseArgs({
    args: sub, allowPositionals: true, strict: false,
    options: {
      project: { type: "string" }, "agent-id": { type: "string" }, days: { type: "string" }, limit: { type: "string" },
      path: { type: "string", multiple: true }, "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false },
    },
  });
  if (v.help) { printImportHelp(); return; }
  const days = v.days !== undefined ? Number(v.days) : DEFAULT_MAX_AGE_DAYS;
  const limit = v.limit !== undefined ? Number(v.limit) : DEFAULT_MAX_COUNT;
  const json = !!v.json;

  if (rest[0] === "detect") {
    const found = detect(days);
    if (json) { console.log(JSON.stringify({ sources: found, days })); return; }
    for (const d of found) {
      const color = d.sessions ? GREEN : DIM;
      process.stderr.write(`${color}${d.kind.padEnd(7)}${RESET} ${d.sessions} sessions (${d.recent} in last ${days}d)  ${DIM}${d.home}${RESET}\n`);
    }
    return;
  }

  const kinds: SourceKind[] = rest[0] && SOURCES.includes(rest[0] as SourceKind) ? [rest[0] as SourceKind] : SOURCES;
  if (rest[0] && !SOURCES.includes(rest[0] as SourceKind)) { process.stderr.write(`${RED}Unknown source '${rest[0]}' — use claude or codex${RESET}\n`); process.exit(2); }
  const projectId = (v.project as string) || scopedProject;
  if (!projectId && !v["dry-run"]) { process.stderr.write(`${RED}No project — pass --project <id>${RESET}\n`); process.exit(2); }

  const explicit = (v.path as string[] | undefined) ?? [];
  const skipped: string[] = [];
  const sessions = explicit.length ? collectExplicit(kinds.length === 1 ? kinds[0] : undefined, explicit, skipped) : collect(kinds, days, limit);
  if (!json) for (const f of skipped) process.stderr.write(`${YELLOW}skip ${f}: not a readable session${RESET}\n`);
  if (!sessions.length) {
    if (json) console.log(JSON.stringify({ imported: [], total: 0, skipped }));
    else process.stderr.write(`${DIM}Nothing to import (${kinds.join(", ")}, last ${days}d).${RESET}\n`);
    return;
  }

  if (v["dry-run"]) {
    const rows = sessions.map(s => ({ kind: s.kind, title: s.title, cwd: s.cwd, messages: s.messages.length, path: s.path, modifiedAt: s.modifiedAt }));
    if (json) { console.log(JSON.stringify({ sessions: rows, limit, skipped })); return; }
    for (const r of rows) process.stderr.write(`${CYAN}${r.kind.padEnd(7)}${RESET} ${r.title}  ${DIM}${r.messages} msgs · ${r.cwd}${RESET}\n`);
    process.stderr.write(`${DIM}${rows.length} session(s) — dry run, nothing written${RESET}\n`);
    return;
  }

  if (!api) throw new Error("import: not authenticated");
  let fallbackAgent = (v["agent-id"] as string) || defaultAgentId;
  if (!fallbackAgent) {
    const agents = await api.listAgentSettings();
    fallbackAgent = agents[0]?.id;
    if (!fallbackAgent) { process.stderr.write(`${RED}No agent found — pass --agent-id <id>${RESET}\n`); process.exit(2); }
  }
  const agentCache = new Map<string, string>();
  const results: any[] = [];
  for (const s of sessions) {
    const agentSettingsId = v["agent-id"] ? fallbackAgent : await agentForCwd(api, s.cwd, fallbackAgent, agentCache);
    try {
      const r = await api.importSession({
        projectId: projectId!, agentSettingsId, title: s.title, messages: s.messages,
        source: { kind: s.kind, path: s.path, sha256: s.sha256, cwd: s.cwd },
      });
      results.push({ ...r, kind: s.kind, title: s.title, path: s.path });
      if (!json) {
        const mark = r.outcome === "unchanged" ? `${DIM}=` : `${GREEN}✓`;
        process.stderr.write(`${mark} ${r.outcome.padEnd(9)}${RESET} ${s.title}  ${DIM}${r.messageCount} msgs · ${r.todoId}${RESET}\n`);
      }
    } catch (e: any) {
      results.push({ kind: s.kind, title: s.title, path: s.path, error: e.message });
      if (!json) process.stderr.write(`${RED}✗ failed    ${RESET} ${s.title}  ${DIM}${e.message}${RESET}\n`);
    }
  }
  const failed = results.filter(r => r.error).length;
  if (json) console.log(JSON.stringify({ imported: results, total: results.length, skipped }));
  else {
    const created = results.filter(r => r.outcome === "created").length;
    const updated = results.filter(r => r.outcome === "updated").length;
    process.stderr.write(`${GREEN}Imported ${created} new, ${updated} updated${failed ? `, ${RED}${failed} failed` : ""}${RESET}\n`);
  }
  if (failed) process.exitCode = 1;
}
