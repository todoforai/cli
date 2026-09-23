/** Process teardown: a CLI that dies must not leave its todo running server-side.
 *
 * watchTodo registers the run it follows; any exit path (signal, lost backend,
 * dead isolated bridge) goes through `shutdown`, which stops that run with the
 * same frame as the web Stop button (`todo:interrupt_signal`), then runs the
 * registered cleanups (mayfly bridge) and exits. The cancel is bounded so a
 * dead backend can't block exit. */

import type { FrontendWebSocket } from "@shared/api";

type Run = { ws: FrontendWebSocket; projectId: string; todoId: string };

let activeRun: Run | null = null;
const cleanups: Array<() => void> = [];
let exiting = false;

export const CANCEL_TIMEOUT_MS = 5_000;

/** The run to cancel if this process goes away; null once it reached a terminal state. */
export function setActiveRun(run: Run | null) { activeRun = run; }

/** Synchronous teardown step run right before exit (idempotent fns only). */
export function onShutdown(fn: () => void) { cleanups.push(fn); }

let cancelling: Promise<boolean> | null = null;

/** Send the stop for the active run (reconnecting if needed); resolves false on failure/timeout.
 *  Concurrent callers share one attempt, so a second signal can't skip the cancel. */
export function cancelActiveRun(timeoutMs = CANCEL_TIMEOUT_MS): Promise<boolean> {
  if (cancelling) return cancelling;
  const run = activeRun;
  if (!run) return Promise.resolve(false);
  const attempt = (async () => {
    if (!run.ws.connected && !(await run.ws.connect())) return false;
    return run.ws.sendInterrupt(run.projectId, run.todoId);
  })().catch(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), timeoutMs); });
  cancelling = Promise.race([attempt, timeout]).finally(() => {
    clearTimeout(timer);
    if (activeRun === run) activeRun = null;
    cancelling = null;
  });
  return cancelling;
}

/** Cancel the active run, run cleanups, exit. Repeat calls/signals are no-ops:
 *  the first one is already bounded by CANCEL_TIMEOUT_MS. */
export async function shutdown(code: number, reason?: string): Promise<void> {
  if (exiting) return new Promise(() => {}); // the first shutdown owns the exit
  exiting = true;
  if (reason) process.stderr.write(`\n${reason}\n`);
  const todoId = activeRun?.todoId;
  if (todoId) {
    const ok = await cancelActiveRun();
    process.stderr.write(ok ? `Stopped todo ${todoId}\n` : `Warning: could not stop todo ${todoId} (backend unreachable)\n`);
  }
  for (const fn of cleanups.splice(0)) { try { fn(); } catch {} }
  process.exit(code);
}

export function installSignalHandlers() {
  process.on("SIGINT", () => void shutdown(130, "Cancelled by user (Ctrl+C)"));
  process.on("SIGTERM", () => void shutdown(143, "Terminated (SIGTERM)"));
  process.on("SIGHUP", () => void shutdown(129, "Hangup (SIGHUP)"));
}
