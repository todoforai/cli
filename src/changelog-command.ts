/** `tfa-cli changelog` — show recent releases for CLI, Bridge (built-in tfa-* tools), and the main App. */

import { BRIGHT_WHITE, CYAN, DIM, RED, RESET } from "./colors";

export type ChangelogTarget = "cli" | "bridge" | "app";

export interface ReleaseEntry {
  target: ChangelogTarget;
  version: string;
  date: string;
  bullets: string[];
  url: string;
}

const TARGETS: ChangelogTarget[] = ["cli", "bridge", "app"];
const GITHUB_REPOS: Record<"cli" | "bridge", string> = {
  cli: "todoforai/cli",
  bridge: "todoforai/bridge",
};
const APP_CHANGELOG_URL = "https://todofor.ai/changelog.md";
const APP_CHANGELOG_PAGE = "https://todofor.ai/changelog";

export function printChangelogHelp() {
  process.stderr.write(`
tfa-cli changelog [cli|bridge|app|all] [OPTIONS]

Show recent release notes without leaving the terminal.
  cli      @todoforai/cli releases (default)
  bridge   todoforai-bridge + built-in tfa-* tools
  app      Main web & desktop app changes (todofor.ai/changelog)
  all      Recent releases across app, cli and bridge

Options:
  --limit <N>        Number of releases per target (default: 5, max: 30)
  --since <version>  Only releases newer than <version> (e.g. --since 0.1.95)
  --json             Machine-readable JSON output
`);
}

export function cmpVersion(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/i, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Parse `- ` bullet lines out of a GitHub Release body (ignores compare/npm footers). */
export function parseReleaseBullets(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

/** Parse `## vX.Y.Z — YYYY-MM-DD` sections from `todofor.ai/changelog.md`. */
export function parseAppChangelog(md: string): ReleaseEntry[] {
  const out: ReleaseEntry[] = [];
  let cur: ReleaseEntry | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^##\s+(v\S+)\s*[—–-]\s*(\S+)/);
    if (m) {
      cur = { target: "app", version: m[1], date: m[2], bullets: [], url: APP_CHANGELOG_PAGE };
      out.push(cur);
    } else if (cur && line.startsWith("- ")) {
      cur.bullets.push(line.slice(2).trim());
    }
  }
  return out;
}

export function filterReleases(entries: ReleaseEntry[], since?: string, limit = 5): ReleaseEntry[] {
  const filtered = since ? entries.filter((e) => cmpVersion(e.version, since) > 0) : entries;
  return filtered.slice(0, limit);
}

async function fetchGitHubReleases(target: "cli" | "bridge", limit: number, timeoutMs: number): Promise<ReleaseEntry[]> {
  const repo = GITHUB_REPOS[target];
  const perPage = Math.min(30, Math.max(limit, 10));
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=${perPage}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "todoforai-cli" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} — view at https://github.com/${repo}/releases`);
  }
  const rows = (await res.json()) as Array<{
    tag_name?: string;
    published_at?: string;
    body?: string;
    html_url?: string;
    draft?: boolean;
  }>;
  return rows
    .filter((r) => !r.draft && r.tag_name)
    .map((r) => ({
      target,
      version: r.tag_name!,
      date: (r.published_at || "").slice(0, 10),
      bullets: parseReleaseBullets(r.body || ""),
      url: r.html_url || `https://github.com/${repo}/releases/tag/${r.tag_name}`,
    }));
}

async function fetchAppReleases(timeoutMs: number): Promise<ReleaseEntry[]> {
  const res = await fetch(APP_CHANGELOG_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} — view at ${APP_CHANGELOG_PAGE}`);
  return parseAppChangelog(await res.text());
}

export async function fetchTargetReleases(
  target: ChangelogTarget,
  opts: { limit?: number; since?: string; timeoutMs?: number } = {},
): Promise<ReleaseEntry[]> {
  const limit = opts.limit ?? 5;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const raw = target === "app"
    ? await fetchAppReleases(timeoutMs)
    : await fetchGitHubReleases(target, opts.since ? 30 : limit, timeoutMs);
  return filterReleases(raw, opts.since, limit);
}

function formatSection(target: ChangelogTarget, entries: ReleaseEntry[], showHeading: boolean): string {
  const labels: Record<ChangelogTarget, string> = {
    cli: "CLI (@todoforai/cli)",
    bridge: "Bridge (todoforai-bridge & built-in tfa-* tools)",
    app: "App (todofor.ai)",
  };
  const lines: string[] = [];
  if (showHeading) lines.push(`${BRIGHT_WHITE}${labels[target]}${RESET}`);
  if (!entries.length) {
    lines.push(`${DIM}  (no newer releases)${RESET}`);
    return lines.join("\n");
  }
  for (const rel of entries) {
    const date = rel.date ? `  ${DIM}${rel.date}${RESET}` : "";
    lines.push(`${CYAN}${rel.version}${RESET}${date}`);
    if (rel.bullets.length) {
      for (const b of rel.bullets) lines.push(`  - ${b}`);
    } else {
      lines.push(`  ${DIM}${rel.url}${RESET}`);
    }
  }
  return lines.join("\n");
}

/** Best-effort summary printed right after `tfa-cli update` installs a newer version. */
export async function printChangesSince(oldVersion: string): Promise<void> {
  try {
    const entries = await fetchTargetReleases("cli", { since: oldVersion, limit: 10, timeoutMs: 3000 });
    if (!entries.length) return;
    process.stderr.write(`\n${BRIGHT_WHITE}What changed since v${oldVersion}:${RESET}\n`);
    process.stderr.write(formatSection("cli", entries, false) + "\n");
  } catch {
    // Update already succeeded — never fail or spam on offline/rate-limit.
  }
}

export async function changelogCommand(positionals: string[], args: Record<string, any>): Promise<void> {
  const rawTarget = (positionals[1] || "cli").toLowerCase();
  if (rawTarget !== "all" && !TARGETS.includes(rawTarget as ChangelogTarget)) {
    process.stderr.write(`${RED}Unknown target "${rawTarget}". Use: cli, bridge, app, or all.${RESET}\n`);
    process.exit(2);
  }
  const limit = Math.min(30, Math.max(1, parseInt(String(args.limit ?? "5"), 10) || 5));
  const since = typeof args.since === "string" && args.since.trim() ? args.since.trim() : undefined;
  const targets: ChangelogTarget[] = rawTarget === "all" ? ["app", "cli", "bridge"] : [rawTarget as ChangelogTarget];

  const results = await Promise.allSettled(
    targets.map((t) => fetchTargetReleases(t, { limit, since })),
  );

  if (args.json) {
    const all: ReleaseEntry[] = [];
    let anyOk = false;
    for (const r of results) {
      if (r.status === "fulfilled") { anyOk = true; all.push(...r.value); }
    }
    console.log(JSON.stringify(all, null, 2));
    if (!anyOk) process.exit(1);
    return;
  }

  let anyOk = false;
  const blocks: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      anyOk = true;
      blocks.push(formatSection(targets[i], r.value, targets.length > 1));
    } else {
      blocks.push(`${RED}${targets[i]}: ${r.reason?.message || r.reason}${RESET}`);
    }
  }
  console.log(blocks.join("\n\n"));
  if (!anyOk) process.exit(1);
}
