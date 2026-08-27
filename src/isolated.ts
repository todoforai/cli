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
  opts: { timeoutMs?: number; debug?: boolean; apiKey?: string } = {},
): Promise<MayflySession> {
  if (!hasBridge()) throw new Error("--isolated requires `todoforai-bridge` on PATH.");
  // Login-less path: a real API key (not a dst_ device-session token) lets the
  // bridge authenticate directly — no `login`, no credentials.json, no Device
  // row. This is what makes --isolated work in fresh containers/CI with only
  // an API key in the environment. dst_ tokens aren't API keys, so those (and
  // keyless runs) fall back to the device-credential flow.
  const loginless = !!opts.apiKey && !opts.apiKey.startsWith("dst_");
  if (!loginless && !ensureBridgeCredentials(apiUrl)) throw new Error("`todoforai-bridge login` did not complete.");

  const args = [...bridgeRunArgs(apiUrl), "--mayfly", todoId, "--workspace", workspace];
  // Key travels via env, not argv — argv is world-readable in `ps`.
  const env = loginless ? { ...process.env, TODOFORAI_MAYFLY_API_KEY: opts.apiKey! } : process.env;
  const child = spawn("todoforai-bridge", args, { stdio: ["ignore", "pipe", "pipe"], env });

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
    // Keep the bridge's own diagnosis ("API key rejected by server.") so a
    // failure reports its cause instead of a bare readiness timeout.
    let lastErr = "";
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`Isolated bridge not ready after ${timeoutMs / 1000}s.${lastErr ? ` ${lastErr}` : ""}`));
    }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      if (readyRx.test(buf)) { clearTimeout(timer); resolvePromise(); }
    });
    child.stderr!.on("data", (d: Buffer) => {
      const s = d.toString();
      const err = s.match(/^error: .*$/m);
      if (err) lastErr = err[0];
      if (opts.debug) process.stderr.write(d);
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => {
      if (!stopped) {
        clearTimeout(timer);
        reject(new Error(lastErr || `Isolated bridge exited early (code ${code}).`));
      }
    });
  });

  return { child, stop };
}
