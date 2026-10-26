/** `todoforai-cli list` — list todos (gh issue list style).
 *
 * Defaults mirror `gh issue list`:
 *   - open-only (hides DONE/ARCHIVED/DELETED)
 *   - last 30, recent first (by lastActivityAt)
 *
 * Uses the backend's cursor-paginated endpoint. Pass the printed `--cursor`
 * value to fetch the next page.
 */

import { parseArgs } from "util";
import { TodoStatus, CLOSED_STATUSES } from "@shared/fbe";
import { CYAN, DIM, GREEN, YELLOW, RED, RESET } from "./colors";

const STATUS_COLOR: Record<string, string> = {
  DONE: GREEN, READY: GREEN, READY_CHECKED: GREEN,
  ERROR: RED, ERROR_CHECKED: RED, CANCELLED: RED, CANCELLED_CHECKED: RED,
  RUNNING: YELLOW, STOPPING: YELLOW, COMPACTING: YELLOW, REVIEW_REQUESTED: YELLOW,
  TODO: CYAN, SCHEDULED: CYAN, POSTPONED: CYAN, PAUSED: CYAN,
};

// "Closed" / hidden by default — analogous to gh's --state open default.
const CLOSED = new Set<string>(CLOSED_STATUSES);

const VALID_STATUS = new Set<string>(Object.values(TodoStatus));
const isOpen = (s: string) => !CLOSED.has(s);

export function printListTodosHelp() {
  process.stderr.write(`
todoforai-cli list [flags] — todos of a project, newest first (lastActivityAt)

Scope:  yours only (todos you opened or wrote in) → --project-wide = every member's
        open only (hides DONE, ARCHIVED, DELETED)  → -A / --all = closed too
Output: STATUS  YYYY-MM-DD HH:MM  <todoId>  <first line of content>
        --json → { items: [{ id, status, content, lastActivityAt, createdAt, contributorIds, … }], nextCursor }

Filters (all combinable):
  -s, --status <S,S2>    exact statuses, union (closed ones included); OPEN = any non-closed
      --search <text>    content/status substring (backend)
      --contributor <u>  id or email, comma = any; replaces the "yours" default
      --since/--until <t> window on the sort field: epoch ms | YYYY-MM-DD | ISO | 12h / 3d (ago)
      --sort created     by createdAt instead of activity
      --project <id>     other project (default: the current one)

Paging: -n <limit> (default 30). "Next cursor: N" on stderr / nextCursor in JSON → re-run with --cursor N.

Examples:
  todoforai-cli list -s RUNNING,REVIEW_REQUESTED
  todoforai-cli list --project-wide -A --since 7d --json | jq -r '.items[] | [.id, .status] | @tsv'
`);
}

function positiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    process.stderr.write(`${RED}Error: ${name} must be a positive integer${RESET}\n`);
    process.exit(2);
  }
  return n;
}

function cursorValue(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(`${RED}Error: --cursor must be a non-negative number${RESET}\n`);
    process.exit(2);
  }
  return n;
}

/** epoch ms | YYYY-MM-DD (local midnight) | ISO datetime | relative "12h"/"3d"/"30m" ago. */
export function parseTime(value: unknown, name: string, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const s = String(value).trim();
  const rel = s.match(/^(\d+)([mhd])$/);
  let n: number;
  if (/^\d+$/.test(s)) n = Number(s);
  else if (rel) n = now - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "m" | "h" | "d"];
  else n = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00` : s);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(`${RED}Error: ${name} must be epoch ms, YYYY-MM-DD, ISO datetime or e.g. 12h / 3d${RESET}\n`);
    process.exit(2);
  }
  return n;
}

function toItemsPage(response: any): { items: any[]; nextCursor?: number } {
  // Back-compat for older/dev backends that returned a bare array.
  if (Array.isArray(response)) return { items: response };
  return {
    items: Array.isArray(response?.items) ? response.items : [],
    nextCursor: typeof response?.nextCursor === "number" ? response.nextCursor : undefined,
  };
}

function rowTime(t: any, sort: string = "activity"): number {
  return Number((sort === "created" ? t.createdAt : t.lastActivityAt ?? t.createdAt) ?? 0);
}

/** Comma list of user ids or member emails → user ids (emails resolved via project members). */
async function resolveContributors(api: any, projectId: string, raw: string): Promise<string[]> {
  const wanted = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (!wanted.some(w => w.includes("@"))) return wanted;
  const members: { id: string; email?: string }[] = await api.getProjectMembers(projectId);
  return wanted.map(w => {
    if (!w.includes("@")) return w;
    const m = members.find(m => m.email?.toLowerCase() === w.toLowerCase());
    if (!m) { process.stderr.write(`${RED}Error: no project member with email ${w}${RESET}\n`); process.exit(2); }
    return m!.id;
  });
}

function printStatusError(unknown: string[]) {
  process.stderr.write(`${RED}Error: unknown status ${unknown.map(s => `'${s}'`).join(", ")}${RESET}\n`);
  process.stderr.write(`${DIM}Use OPEN or one of: ${Object.values(TodoStatus).join(", ")}${RESET}\n`);
  process.exit(2);
}

function matchesRequestedStatus(t: any, requested: string[] | null, wanted: Set<string> | null, wantOpen: boolean) {
  if (!requested) return true;
  const s = String(t.status).toUpperCase();
  return (wantOpen && isOpen(s)) || (wanted?.has(s) ?? false);
}

export async function listTodosCommand(
  api: any, defaultProjectId: string | undefined, argv: string[],
  /** Caller's user id; drives the default "mine" filter. Unresolvable → project-wide. */
  resolveUserId?: () => Promise<string | undefined>,
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit:      { type: "string",  short: "n" },
      cursor:     { type: "string" },
      "page-size": { type: "string" },
      search:     { type: "string" },
      since:      { type: "string" },
      until:      { type: "string" },
      sort:       { type: "string" },
      contributor: { type: "string" },
      "project-wide": { type: "boolean", default: false },
      status:     { type: "string",  short: "s" },
      all:        { type: "boolean", short: "A", default: false },
      project:    { type: "string" },
      json:       { type: "boolean", default: false },
      help:       { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) { printListTodosHelp(); return; }

  const projectId = (values.project as string) || defaultProjectId;
  if (!projectId) { process.stderr.write(`${RED}Error: no project (pass --project <id> or set a default)${RESET}\n`); process.exit(1); }

  const limit = positiveInt(values.limit, "--limit") ?? 30;
  const pageSize = Math.min(positiveInt(values["page-size"], "--page-size") ?? Math.min(Math.max(limit, 1), 400), 400);
  const sort = values.sort === undefined ? "activity" : String(values.sort);
  if (sort !== "activity" && sort !== "created") {
    process.stderr.write(`${RED}Error: --sort must be activity or created${RESET}\n`);
    process.exit(2);
  }
  const since = parseTime(values.since, "--since");
  const until = parseTime(values.until, "--until");
  // --until is just the first page's exclusive cursor; an explicit --cursor further back wins.
  let cursor = cursorValue(values.cursor);
  if (until !== undefined) cursor = cursor === undefined ? until : Math.min(cursor, until);
  const search = values.search ? String(values.search) : undefined;
  let contributorIds = values.contributor
    ? await resolveContributors(api, projectId, String(values.contributor))
    : undefined;
  let mineOnly = false;
  if (!contributorIds && !values["project-wide"] && resolveUserId) {
    const me = await resolveUserId();
    if (me) { contributorIds = [me]; mineOnly = true; }
  }

  // Parse --status. "OPEN" is a pseudo-status meaning "any non-closed". Unknown
  // statuses fall back to OPEN (so a typo/legacy value shows the open list, not nothing).
  const requested = values.status
    ? String(values.status).split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
    : null;
  const unknown = requested?.filter(s => s !== "OPEN" && !VALID_STATUS.has(s)) ?? [];
  if (unknown.length) printStatusError(unknown);
  const wantOpen = !!requested?.some(s => s === "OPEN");
  const wanted = requested ? new Set(requested.filter(s => VALID_STATUS.has(s))) : null;
  const includeClosed = !!values.all || (!!wanted && wanted.size > 0);

  const rows: any[] = [];
  let backendNextCursor: number | undefined;

  while (rows.length < limit) {
    const requestLimit = Math.min(pageSize, limit - rows.length);
    const page = toItemsPage(await api.listTodos(projectId, {
      limit: requestLimit, cursor, search, since, contributorIds,
      // Server-side open-only filter; the loop below re-checks for older backends.
      ...(!includeClosed && { excludeClosed: true }),
      ...(sort !== "activity" && { sort }),
    }));
    backendNextCursor = page.nextCursor;

    let exhausted = false;
    for (const t of page.items) {
      // Re-check client-side: a backend predating `since`/`sort` ignores them. Pages
      // come newest-first by activity or createdAt, and createdAt <= lastActivityAt,
      // so once activity drops below `since` nothing further can match: stop paging.
      if (since !== undefined && rowTime(t) < since) { exhausted = true; break; }
      if (since !== undefined && rowTime(t, sort) < since) continue;
      const status = String(t.status).toUpperCase();
      if (!includeClosed && CLOSED.has(status)) continue;
      if (!matchesRequestedStatus(t, requested, wanted, wantOpen)) continue;
      rows.push(t);
      if (rows.length >= limit) break;
    }

    if (exhausted) { backendNextCursor = undefined; break; }
    if (!backendNextCursor || page.items.length === 0) break;
    cursor = backendNextCursor;
  }

  rows.sort((a, b) => rowTime(b, sort) - rowTime(a, sort));
  const visible = rows.slice(0, limit);

  // Use the last printed row as the next cursor only when either the backend
  // reported another page, or we fetched more matching rows than we printed.
  // That preserves client-side filters without claiming a next page exists when
  // the backend returned the final page exactly at the requested limit.
  const hasBufferedRows = rows.length > visible.length;
  const nextCursor = visible.length && (backendNextCursor !== undefined || hasBufferedRows)
    ? rowTime(visible[visible.length - 1], sort)
    : undefined;

  if (values.json) {
    process.stdout.write(JSON.stringify({ items: visible, nextCursor }, null, 2) + "\n");
    return;
  }

  const scopeHint = mineOnly ? " of yours (--project-wide for everyone's)" : "";
  if (!visible.length) {
    process.stderr.write(`${DIM}(no todos${scopeHint})${RESET}\n`);
    if (nextCursor !== undefined) process.stderr.write(`${DIM}Next cursor: ${nextCursor} (re-run with the same filters plus --cursor ${nextCursor})${RESET}\n`);
    return;
  }

  const statusW = visible.reduce((n, r) => Math.max(n, String(r.status).length), 0);
  for (const t of visible) {
    const status = String(t.status).toUpperCase();
    const sc = STATUS_COLOR[status] || DIM;
    const ts = new Date(rowTime(t, sort)).toISOString().slice(0, 16).replace("T", " ");
    const title = String(t.content ?? "").split("\n")[0].slice(0, 100);
    process.stdout.write(`${sc}${status.padEnd(statusW)}${RESET}  ${DIM}${ts}${RESET}  ${t.id}  ${title}\n`);
  }
  process.stderr.write(`${DIM}${visible.length} todo(s)${scopeHint}${RESET}\n`);
  if (nextCursor !== undefined) process.stderr.write(`${DIM}Next cursor: ${nextCursor} (re-run with the same filters plus --cursor ${nextCursor})${RESET}\n`);
}
