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
import { restBasePath } from "@shared/api";
import { bridgeRunArgs, ensureBridgeCredentials, hasBridge } from "./ensure-bridge";

export interface MayflySession {
  child: ChildProcess;
  /** SIGTERM the bridge; idempotent. */
  stop: () => void;
}

/** Trade the API key for a short-lived token scoped to this one todo.
 *
 * The bridge spawns the agent's PTYs, and a process environment is inherited,
 * not sandboxed — so the durable key must never get that close. This token is
 * worth one todo for a few minutes and is rejected by the REST API outright,
 * which also means the bridge's first-connect TOFU exposes only that. */
async function mintMayflyToken(apiUrl: string, apiKey: string, todoId: string): Promise<string> {
  const res = await fetch(`${apiUrl}${restBasePath(apiKey)}/cli/mayfly/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ todoId }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`--isolated: could not mint a session token (${res.status} ${text.slice(0, 200)}).`);
  const token = JSON.parse(text)?.token;
  if (typeof token !== "string" || !token) throw new Error("--isolated: token mint returned no token.");
  return token;
}

export async function spawnMayflyBridge(
  apiUrl: string,
  todoId: string,
  workspace: string,
  opts: { timeoutMs?: number; debug?: boolean; apiKey?: string } = {},
): Promise<MayflySession> {
  if (!hasBridge()) throw new Error("--isolated requires `todoforai-bridge` on PATH.");
  // Login-less path: a real API key (not a dst_ device-session token, which
  // can't mint) lets us hand the bridge a scoped token instead of a device
  // identity — no `login`, no credentials.json, no Device row. This is what
  // makes --isolated work in fresh containers/CI with only an API key in the
  // environment. Keyless runs and dst_ tokens fall back to device credentials.
  const loginless = !!opts.apiKey && !opts.apiKey.startsWith("dst_");
  if (!loginless && !ensureBridgeCredentials(apiUrl)) throw new Error("`todoforai-bridge login` did not complete.");
  const sessionToken = loginless ? await mintMayflyToken(apiUrl, opts.apiKey!, todoId) : null;

  const args = [...bridgeRunArgs(apiUrl), "--mayfly", todoId, "--workspace", workspace];
  // Token travels via env, not argv — argv is world-readable in `ps`.
  //
  // And the durable key must NOT: in CI it arrives as TODOFORAI_API_TOKEN, so a
  // plain `...process.env` would hand the bridge (and therefore every agent
  // shell that inherits from it) the very credential this whole exchange exists
  // to keep out. Drop every alias getEnv() would read — see args.ts — plus the
  // variable an older bridge used for the same job.
  const env = { ...process.env };
  if (sessionToken) {
    for (const n of ["API_TOKEN", "MAYFLY_API_KEY"])
      for (const p of ["TODOFORAI_", "TODO4AI_"]) delete env[p + n];
    env.TODOFORAI_MAYFLY_TOKEN = sessionToken;
  }
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
    // Keep the bridge's own diagnosis ("session token rejected") so a failure
    // reports its cause instead of a bare readiness timeout.
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
