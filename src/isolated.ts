/** --isolated: spawn a mayfly bridge — an ephemeral connector scoped to ONE todo.
 *
 * Scramjet pattern, todoId-keyed: the CLI mints the todoId up front, the bridge
 * runs with `--mayfly <todoId> --workspace <cwd>` and registers server-side under
 * the in-memory id `mayfly-<todoId>` (no Device row, absent from every device
 * list). While it lives, that todo's dispatches see EXACTLY this device — no
 * cloud VM, no other PCs, no browsers. Killing the child (or the CLI exiting)
 * evaporates the session server-side and later runs degrade to the normal
 * device snapshot. */

import { spawn, type ChildProcess } from "child_process";
import { bridgeRunArgs, ensureBridgeCredentials, hasBridge } from "./ensure-bridge";

export interface MayflySession {
  child: ChildProcess;
  /** SIGTERM the bridge; idempotent. */
  stop: () => void;
}

export async function spawnMayflyBridge(
  apiUrl: string,
  todoId: string,
  workspace: string,
  opts: { timeoutMs?: number; debug?: boolean } = {},
): Promise<MayflySession> {
  if (!hasBridge()) throw new Error("--isolated requires `todoforai-bridge` on PATH.");
  if (!ensureBridgeCredentials(apiUrl)) throw new Error("`todoforai-bridge login` did not complete.");

  const args = [...bridgeRunArgs(apiUrl), "--mayfly", todoId, "--workspace", workspace];
  const child = spawn("todoforai-bridge", args, { stdio: ["ignore", "pipe", "pipe"] });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { child.kill("SIGTERM"); } catch {}
  };
  // The mayfly session is meaningless past this CLI process — never outlive it.
  process.on("exit", stop);

  // Wait for the bridge's machine-readable readiness line so the todo's first
  // dispatch is guaranteed to find the session registered.
  const readyRx = new RegExp(`^BRIDGE_READY id=mayfly-${todoId}\\b`, "m");
  await new Promise<void>((resolvePromise, reject) => {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    let buf = "";
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`Isolated bridge not ready after ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      if (readyRx.test(buf)) { clearTimeout(timer); resolvePromise(); }
    });
    if (opts.debug) child.stderr!.on("data", (d: Buffer) => process.stderr.write(d));
    else child.stderr!.resume();
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => {
      if (!stopped) { clearTimeout(timer); reject(new Error(`Isolated bridge exited early (code ${code}).`)); }
    });
  });

  return { child, stop };
}
