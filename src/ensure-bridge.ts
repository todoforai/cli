/** Spawn a detached bridge daemon if none is running. */

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

function hasBridge(): boolean {
  const probe = spawnSync("todoforai-bridge", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function parseApiUrl(apiUrl: string): URL | null {
  try {
    return new URL(apiUrl);
  } catch {
    return null;
  }
}

function bridgeProfile(apiUrl: string): string | null {
  const url = parseApiUrl(apiUrl);
  if (!url) return null;
  if (isLocalHost(url.hostname)) return "dev";
  if (!url.hostname || url.hostname === "api.todofor.ai") return null;
  return `api_${url.hostname.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function withProfile(args: string[], apiUrl: string): string[] {
  const profile = bridgeProfile(apiUrl);
  return profile ? [...args, "--profile", profile] : args;
}

function bridgeRunArgs(apiUrl: string): string[] {
  const url = parseApiUrl(apiUrl);
  if (!url) return [];

  // `todoforai-bridge --port` is the bridge HTTP/WS port (80 prod, 4000 dev),
  // not the public HTTPS API port. Only carry an API URL port through for local
  // dev, where `http://localhost:4000` maps directly to the bridge endpoint.
  if (isLocalHost(url.hostname)) {
    const args = ["--host", url.hostname];
    if (url.port) args.push("--port", url.port);
    return withProfile(args, apiUrl);
  }

  // Production defaults to api.todofor.ai:80 internally. For custom backends,
  // pass the host but let bridge pick its default plaintext bridge port.
  if (url.hostname && url.hostname !== "api.todofor.ai") return withProfile(["--host", url.hostname], apiUrl);
  return [];
}

function bridgeLoginArgs(apiUrl: string): string[] {
  const url = parseApiUrl(apiUrl);
  if (!url) return ["login"];
  if (url.hostname && url.hostname !== "api.todofor.ai") return withProfile(["login", "--host", url.hostname], apiUrl);
  return ["login"];
}

function bridgeWhoamiArgs(apiUrl: string): string[] {
  return withProfile(["whoami"], apiUrl);
}

/** Local bridge device id for this apiUrl's profile, or null if not logged in.
 *  Parses `todoforai-bridge whoami` ("Device: <name> (id: <uuid>)"). */
export function bridgeDeviceId(apiUrl: string): string | null {
  const r = spawnSync("todoforai-bridge", bridgeWhoamiArgs(apiUrl), { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const m = (r.stdout || "").match(/^Device:.*\(id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/im);
  return m ? m[1] : null;
}

function ensureBridgeCredentials(apiUrl: string): boolean {
  const whoami = spawnSync("todoforai-bridge", bridgeWhoamiArgs(apiUrl), { stdio: "ignore" });
  if (whoami.status === 0) return true;

  // Do not hide the bridge's first-run device-login URL in bridge.log. Run the
  // login subcommand in the foreground once, then spawn the daemon detached.
  console.error("\x1b[2mBridge credentials not found. Starting `todoforai-bridge login`...\x1b[0m");
  const login = spawnSync("todoforai-bridge", bridgeLoginArgs(apiUrl), { stdio: "inherit" });
  return login.status === 0;
}


function bridgeAlreadyRunning(): Promise<boolean> {
  if (process.platform === "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    const r = spawn("pgrep", ["-f", "todoforai-bridge"]);
    let out = "";
    r.stdout.on("data", (d) => (out += d));
    r.on("error", () => resolve(false));
    // Exclude our own pgrep/login invocations: any surviving pid means a daemon runs.
    r.on("close", (code) => resolve(code === 0 && out.trim().length > 0));
  });
}

export async function ensureBridgeRunning(apiUrl: string, _apiKey: string) {
  if (await bridgeAlreadyRunning()) return; // normal case: daemon already up — stay quiet

  if (!hasBridge()) {
    console.error("\x1b[2mBridge not started: `todoforai-bridge` was not found on PATH. Install TODOforAI Bridge, or pass --no-bridge (or deprecated --no-edge) to silence this.\x1b[0m");
    return;
  }

  if (!ensureBridgeCredentials(apiUrl)) {
    console.error("\x1b[33mBridge not started: `todoforai-bridge login` did not complete successfully.\x1b[0m");
    return;
  }

  const logDir = path.join(os.homedir(), ".todoforai");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "bridge.log");
  const out = fs.openSync(logFile, "a");

  const child = spawn("todoforai-bridge", bridgeRunArgs(apiUrl), {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.on("error", (err) => {
    console.error(`\x1b[33mFailed to start bridge: ${err.message}\x1b[0m`);
  });

  let exited = false;
  let exitCode: number | null = null;
  child.on("exit", (code) => { exited = true; exitCode = code; });
  child.unref();

  if (!child.pid) return;
  const shortLog = logFile.replace(os.homedir(), "~");
  setTimeout(() => {
    // We only spawned because no daemon was running, so an early death is a
    // real failure (e.g. stale credentials) — worth one dim line.
    if (exited && exitCode !== 0) {
      console.error(`\x1b[2mBridge not running (exit ${exitCode}), see ${shortLog}\x1b[0m`);
    }
  }, 500);
}
