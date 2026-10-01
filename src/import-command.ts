/** `tfa-cli import` — bring Claude Code / Codex sessions into TODOforAI as finished todos.
 *
 * Runs where the session files live (the user's machine, i.e. the bridge host): parse
 * locally, send only the flattened transcript to `POST /todos/import`. The backend keys
 * on (source path, sha256), so re-running is idempotent and picks up changed sessions.
 *
 *   tfa-cli import [claude|codex] [flags]     newest sessions of both / one source
 *   tfa-cli import <file.jsonl>...            exactly these session files
 */
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
const SOURCES: SourceKind[] = ["claude", "codex"];

export function printImportHelp() {
  process.stderr.write(`
tfa-cli import — import Claude Code / Codex sessions as todos

Usage:
  tfa-cli import [claude|codex] [flags]
  tfa-cli import <session.jsonl>... [flags]

Flags:
      --project <id>      Target project (default: current default project)
  -a, --agent <id|name>   Agent for every imported todo (default: match the session cwd, else your default agent)
      --days <n>          Only sessions modified in the last n days (default: ${DEFAULT_MAX_AGE_DAYS}; 0 = all)
      --limit <n>         Max sessions per source, newest first (default: ${DEFAULT_MAX_COUNT}; 0 = all)
      --dry-run           Parse and list, write nothing (no login needed)
      --json              Machine-readable output
  -h, --help              Show this help

Sources on this machine:
  Claude Code  ${claudeHome()}/projects/*/*.jsonl
  Codex        ${codexHome()}/sessions/**/rollout-*.jsonl
`);
}

let codexTitles: Map<string, string> | undefined;
function safeParse(kind: SourceKind, file: string): ExternalSession | null {
  try { return kind === "claude" ? parseClaudeSession(file) : parseCodexSession(file, codexTitles ??= readCodexTitles()); } catch { return null; }
}

/** Newest `limit` sessions per source modified within `days` (mtime-filtered before parsing). */
function collect(kinds: SourceKind[], days: number, limit: number): ExternalSession[] {
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  return kinds.flatMap(kind => {
    const files = kind === "claude" ? listClaudeSessionFiles() : listCodexSessionFiles();
    const sessions = files.map(f => ({ f, mtime: statSync(f).mtimeMs }))
      .filter(x => x.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime)
      .map(x => safeParse(kind, x.f))
      .filter((s): s is ExternalSession => !!s);
    return limit > 0 ? sessions.slice(0, limit) : sessions;
  });
}

/** Agent whose workspace contains the session cwd (walking up), else `fallback`. Cached per directory. */
async function agentForCwd(api: ApiClient, cwd: string, fallback: string, cache: Map<string, string>): Promise<string> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const hit = cache.get(dir);
    if (hit) return hit;
    const matches = await api.listAgentSettings({ workspacePath: dir }).catch(() => []);
    if (matches.length) { cache.set(dir, matches[0].id); return matches[0].id; }
    if (dirname(dir) === dir) break;
  }
  cache.set(cwd, fallback);
  return fallback;
}

export async function importCommand(api: ApiClient | null, positionals: string[], args: Record<string, any>, scopedProject?: string, defaultAgentId?: string) {
  const days = args.days !== undefined ? Number(args.days) : DEFAULT_MAX_AGE_DAYS;
  const limit = args.limit !== undefined ? Number(args.limit) : DEFAULT_MAX_COUNT;
  const json = !!args.json;

  // Operands: source names, or session files (anything else).
  const ops = positionals.slice(1);
  const named = ops.filter((o): o is SourceKind => SOURCES.includes(o as SourceKind));
  const files = ops.filter(o => !SOURCES.includes(o as SourceKind)).map(f => resolve(f));
  const skipped: string[] = [];
  const sessions = files.length
    ? files.flatMap(f => {
        const kind: SourceKind = named[0] ?? (basename(f).startsWith("rollout-") ? "codex" : "claude");
        const s = safeParse(kind, f);
        if (!s) skipped.push(f);
        return s ? [s] : [];
      })
    : collect(named.length ? named : SOURCES, days, limit);
  if (!json) for (const f of skipped) process.stderr.write(`${YELLOW}skip ${f}: not a readable session${RESET}\n`);

  if (args["dry-run"]) {
    const rows = sessions.map(s => ({ kind: s.kind, title: s.title, cwd: s.cwd, messages: s.messages.length, path: s.path, modifiedAt: s.modifiedAt }));
    if (json) { console.log(JSON.stringify({ sessions: rows, skipped })); return; }
    for (const r of rows) process.stderr.write(`${CYAN}${r.kind.padEnd(7)}${RESET} ${r.title}  ${DIM}${r.messages} msgs · ${r.cwd}${RESET}\n`);
    process.stderr.write(`${DIM}${rows.length} session(s) — dry run, nothing written${RESET}\n`);
    return;
  }

  if (!api) throw new Error("import: not authenticated");
  const projectId = (args.project as string) || scopedProject;
  if (!projectId) { process.stderr.write(`${RED}No project — pass --project <id>${RESET}\n`); process.exit(2); }
  let fallbackAgent = defaultAgentId;
  if (args.agent || !fallbackAgent) {
    const agents = await api.listAgentSettings();
    fallbackAgent = args.agent
      ? agents.find((a: any) => a.id === args.agent || a.name === args.agent)?.id
      : agents[0]?.id;
    if (!fallbackAgent) { process.stderr.write(`${RED}Agent not found — pass --agent <id>${RESET}\n`); process.exit(2); }
  }

  const agentCache = new Map<string, string>();
  const results: any[] = [];
  for (const s of sessions) {
    const agentSettingsId = args.agent ? fallbackAgent : await agentForCwd(api, s.cwd, fallbackAgent, agentCache);
    try {
      const r = await api.importSession({
        projectId, agentSettingsId, title: s.title, messages: s.messages,
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
    const count = (o: string) => results.filter(r => r.outcome === o).length;
    process.stderr.write(`${GREEN}Imported ${count("created")} new, ${count("updated")} updated${failed ? `, ${RED}${failed} failed` : ""}${RESET}\n`);
  }
  if (failed) process.exitCode = 1;
}
