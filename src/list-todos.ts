/** `todoai list` — list todos (gh issue list style).
 *
 * Defaults mirror `gh issue list`:
 *   - open-only (hides DONE/READY_CHECKED/CANCELLED(_CHECKED)/ERROR_CHECKED/ARCHIVED/DELETED)
 *   - last 30, recent first (by lastActivityAt)
 */

import { parseArgs } from "util";
import { TodoStatus } from "@shared/fbe";
import { CYAN, DIM, GREEN, YELLOW, RED, RESET } from "./colors";

const STATUS_COLOR: Record<string, string> = {
  DONE: GREEN, READY: GREEN, READY_CHECKED: GREEN,
  ERROR: RED, ERROR_CHECKED: RED, CANCELLED: RED, CANCELLED_CHECKED: RED,
  RUNNING: YELLOW, STOPPING: YELLOW, COMPACTING: YELLOW, REVIEW_REQUESTED: YELLOW,
  TODO: CYAN, SCHEDULED: CYAN, POSTPONED: CYAN, PAUSED: CYAN,
};

// "Closed" / hidden by default — analogous to gh's --state open default.
const CLOSED = new Set([
  "DONE", "READY_CHECKED", "CANCELLED", "CANCELLED_CHECKED",
  "ERROR_CHECKED", "ARCHIVED", "DELETED",
]);

const VALID_STATUS = new Set<string>(Object.values(TodoStatus));
const isOpen = (s: string) => !CLOSED.has(s);

function printHelp() {
  process.stderr.write(`
todoai list — list todos in a project (recent first)

Usage:
  todoai list [flags]

Flags:
  -n, --limit <n>          Max rows to show (default: 30)
  -s, --status <S[,S2]>    Filter by status (comma-separated, union).
  -A, --all                Include DONE (also CANCELLED, ARCHIVED, …)
      --project <id>       Project ID (default: current default project)
      --json               Output raw JSON
  -h, --help               Show this help

Examples:
  todoai list                       # 30 most recent open todos
  todoai list -n 50                 # last 50 open
  todoai list --all                 # include DONE
  todoai list -s RUNNING,REVIEW_REQUESTED
  todoai list --json | jq '.[].id'
`);
}

export async function listTodosCommand(api: any, defaultProjectId: string | undefined, argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit:   { type: "string",  short: "n" },
      status:  { type: "string",  short: "s" },
      all:     { type: "boolean", short: "A", default: false },
      project: { type: "string" },
      json:    { type: "boolean", default: false },
      help:    { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) { printHelp(); return; }

  const projectId = (values.project as string) || defaultProjectId;
  if (!projectId) { process.stderr.write(`${RED}Error: no project (pass --project <id> or set a default)${RESET}\n`); process.exit(1); }

  const limit = values.limit ? Math.max(1, Number(values.limit)) : 30;
  // Parse --status. "OPEN" is a pseudo-status meaning "any non-closed". Unknown
  // statuses fall back to OPEN (so a typo/legacy value shows the open list, not nothing).
  const requested = values.status
    ? String(values.status).split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
    : null;
  const wantOpen = !!requested?.some(s => s === "OPEN" || !VALID_STATUS.has(s));
  const wanted = requested ? new Set(requested.filter(s => VALID_STATUS.has(s))) : null;
  const includeClosed = !!values.all || (!!wanted && wanted.size > 0);

  const todos: any[] = await api.listTodos(projectId);
  let rows = todos
    .filter(t => includeClosed || !CLOSED.has(String(t.status).toUpperCase()))
    .filter(t => {
      if (!requested) return true;
      const s = String(t.status).toUpperCase();
      return (wantOpen && isOpen(s)) || (wanted?.has(s) ?? false);
    })
    .sort((a, b) => (b.lastActivityAt ?? b.createdAt ?? 0) - (a.lastActivityAt ?? a.createdAt ?? 0))
    .slice(0, limit);

  if (values.json) { process.stdout.write(JSON.stringify(rows, null, 2) + "\n"); return; }

  if (!rows.length) { process.stderr.write(`${DIM}(no todos)${RESET}\n`); return; }

  const statusW = rows.reduce((n, r) => Math.max(n, String(r.status).length), 0);
  for (const t of rows) {
    const sc = STATUS_COLOR[t.status] || DIM;
    const ts = new Date(t.lastActivityAt ?? t.createdAt).toISOString().slice(0, 16).replace("T", " ");
    const title = String(t.content ?? "").split("\n")[0].slice(0, 100);
    process.stdout.write(`${sc}${String(t.status).padEnd(statusW)}${RESET}  ${DIM}${ts}${RESET}  ${t.id}  ${title}\n`);
  }
  process.stderr.write(`${DIM}${rows.length} todo(s)${RESET}\n`);
}
