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

function ensureBridgeCredentials(apiUrl: string): boolean {
  const whoami = spawnSync("todoforai-bridge", bridgeWhoamiArgs(apiUrl), { stdio: "ignore" });
  if (whoami.status === 0) return true;

  // Do not hide the bridge's first-run device-login URL in bridge.log. Run the
  // login subcommand in the foreground once, then spawn the daemon detached.
  console.error("\x1b[2mBridge credentials not found. Starting `todoforai-bridge login`...\x1b[0m");
  const login = spawnSync("todoforai-bridge", bridgeLoginArgs(apiUrl), { stdio: "inherit" });
  return login.status === 0;
}

export function ensureBridgeRunning(apiUrl: string, _apiKey: string) {
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

  const pid = child.pid;
  if (!pid) return;
  const shortLog = logFile.replace(os.homedir(), "~");
  setTimeout(() => {
    if (!exited) {
      console.error(`\x1b[2mStarted bridge (pid ${pid}), logs: ${shortLog}\x1b[0m`);
      return;
    }
    if (exitCode === 0) {
      console.error(`\x1b[2mBridge exited cleanly. Logs: ${shortLog}\x1b[0m`);
    } else {
      console.error(`\x1b[33mBridge exited early (exit ${exitCode}). Check logs: ${shortLog}. Another instance may already be running.\x1b[0m`);
    }
  }, 500);
}
