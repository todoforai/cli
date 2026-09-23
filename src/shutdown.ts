/** Process teardown: a CLI that dies must not leave its todo running server-side.
 *
 * Every started run is registered here; any exit path (signal, lost backend,
 * dead isolated bridge) goes through `shutdown`, which stops that run with the
 * same frame as the web Stop button (`todo:interrupt_signal`), then runs the
 * registered cleanups (mayfly bridge) and exits. Once a shutdown started it
 * owns the exit: `finish` (main() returning/throwing) defers to it, so neither
 * the exit code (130/143/129) nor the stop can be pre-empted. The stop is
 * bounded so a dead backend can't block exit. */

import type { FrontendWebSocket } from "@shared/api";

type Run = { ws: FrontendWebSocket; projectId: string; todoId: string };
/** A run, or one still being created (addMessage in flight) — resolves null if creation failed. */
type PendingRun = Run | Promise<Run | null>;
/** todoId: null = nothing to stop (creation failed), undefined = never learned it (timed out). */
type StopResult = { ok: boolean; todoId?: string | null };

let activeRun: PendingRun | null = null;
const cleanups: Array<() => void> = [];
let exiting: Promise<never> | null = null;
let cancelling: Promise<StopResult> | null = null;

export const CANCEL_TIMEOUT_MS = 5_000;

/** The run to stop if this process goes away; null once it reached a terminal state. */
export function setActiveRun(run: PendingRun | null) { activeRun = run; }

/** Register a run whose todo is still being created/started. A stop requested
 *  meanwhile waits for it — sent earlier, the backend would drop it (no todo
 *  yet) and the todo would start after we exited. */
export function trackStart(ws: FrontendWebSocket, projectId: string, started: Promise<string>) {
  setActiveRun(started.then((todoId) => ({ ws, projectId, todoId }), () => null));
}

/** Synchronous teardown step run right before exit (idempotent fns only). */
export function onShutdown(fn: () => void) { cleanups.push(fn); }

/** Resolve `p`, or `fallback` after `ms` (a late result is ignored). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Stop the active run (reconnecting if needed), bounded by `timeoutMs`.
 *  Concurrent callers share one attempt, so a second signal can't skip it. */
export function cancelActiveRun(timeoutMs = CANCEL_TIMEOUT_MS): Promise<StopResult> {
  if (cancelling) return cancelling;
  const pending = activeRun;
  if (!pending) return Promise.resolve({ ok: false, todoId: null });
  const res: StopResult = { ok: false };
  const attempt = (async () => {
    const run = await pending;
    res.todoId = run?.todoId ?? null;
    if (!run) return res;
    if (!run.ws.connected && !(await run.ws.connect())) return res;
    res.ok = await run.ws.sendInterrupt(run.projectId, run.todoId);
    return res;
  })().catch(() => res);
  cancelling = withTimeout(attempt, timeoutMs, res).finally(() => {
    if (activeRun === pending) activeRun = null;
    cancelling = null;
  });
  return cancelling;
}

/** Stop the active run, run cleanups, exit. The first call owns the exit;
 *  later calls (second signal, fatal error) just await it. */
export function shutdown(code: number, reason?: string): Promise<never> {
  return exiting ??= (async (): Promise<never> => {
    if (reason) process.stderr.write(`\n${reason}\n`);
    if (activeRun) {
      const { ok, todoId } = await cancelActiveRun();
      if (ok) process.stderr.write(`Stopped todo ${todoId}\n`);
      else if (todoId) process.stderr.write(`Warning: could not stop todo ${todoId} (backend unreachable)\n`);
      else if (todoId === undefined) process.stderr.write(`Warning: could not stop the todo being created (timed out)\n`);
    }
    for (const fn of cleanups.splice(0)) { try { fn(); } catch {} }
    process.exit(code);
  })();
}

/** Normal exit once main() settled. Defers to an in-progress shutdown, which
 *  owns the exit code and the stop.
 *  Under bun, process.exit() discards buffered pipe writes, truncating
 *  `list --json | jq` at 64 KiB. end(cb) is the only flush signal that's
 *  honest on both bun 1.3 and 1.4 (writableLength/needDrain report 0 while
 *  data is still buffered); finish() is terminal, so closing stdout is fine. */
export function finish(code: number) {
  if (exiting) return;
  process.exitCode = code;
  process.stdout.end(() => { if (!exiting) process.exit(code); });
}

export function installSignalHandlers() {
  process.on("SIGINT", () => void shutdown(130, "Cancelled by user (Ctrl+C)"));
  process.on("SIGTERM", () => void shutdown(143, "Terminated (SIGTERM)"));
  process.on("SIGHUP", () => void shutdown(129, "Hangup (SIGHUP)"));
}
