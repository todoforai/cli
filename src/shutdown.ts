/** Process teardown. Exiting the CLI (signal, lost backend) only detaches: the
 * todo keeps running server-side and `--resume` reattaches. (An --isolated
 * todo is stopped by the backend once its mayfly bridge is gone.) Any exit path
 * goes through `shutdown`, which prints the resume hint, runs the registered
 * cleanups (mayfly bridge) and exits. Once a shutdown started it owns the exit:
 * `finish` (main() returning/throwing) defers to it, so the exit code
 * (130/143/129) can't be pre-empted. */

let activeTodoId: string | null = null;
const cleanups: Array<() => void> = [];
let exiting: Promise<never> | null = null;

/** The todo being watched (gets a resume hint on exit); null once terminal. */
export function setActiveTodo(todoId: string | null) { activeTodoId = todoId; }

export const detachNotice = (todoId: string) => `Todo keeps running — reattach: tfa-cli --resume ${todoId}\n`;

/** Synchronous teardown step run right before exit (idempotent fns only). */
export function onShutdown(fn: () => void) { cleanups.push(fn); }

/** Resolve `p`, or `fallback` after `ms` (a late result is ignored). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Detach from the active todo, run cleanups, exit. The first call owns the
 *  exit; later calls (second signal, fatal error) just await it. */
export function shutdown(code: number, reason?: string): Promise<never> {
  return exiting ??= (async (): Promise<never> => {
    if (reason) process.stderr.write(`\n${reason}\n`);
    if (activeTodoId) process.stderr.write(detachNotice(activeTodoId));
    for (const fn of cleanups.splice(0)) { try { fn(); } catch {} }
    process.exit(code);
  })();
}

/** Normal exit once main() settled. Defers to an in-progress shutdown, which
 *  owns the exit code.
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
  process.on("SIGINT", () => void shutdown(130, "Exited (Ctrl+C)"));
  process.on("SIGTERM", () => void shutdown(143, "Terminated (SIGTERM)"));
  process.on("SIGHUP", () => void shutdown(129, "Hangup (SIGHUP)"));
}
