/** Spawn a detached bridge daemon if none is running. */

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { ApiClient, restBasePath } from "@shared/api";

const INSTALLER_URL = "https://todofor.ai/bridge";
// The installer's prefix. An installer in a `curl | sh` pipe can't extend THIS
// process's PATH, so after installing we resolve the binary here.
const INSTALL_PREFIX = process.env.TODOFORAI_PREFIX || path.join(os.homedir(), ".todoforai", "bin");
// Hard cap on the install: a stalled download must not hang an ACP host.
const INSTALL_TIMEOUT_MS = 90_000;

/** Absolute path of the bridge binary, or the bare name when it is on PATH. */
let bridgeBin = "todoforai-bridge";
export const bridgeBinary = () => bridgeBin;

function probeBridge(bin: string): boolean {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

export function hasBridge(): boolean {
  if (probeBridge(bridgeBin)) return true;
  const installed = path.join(INSTALL_PREFIX, "todoforai-bridge");
  if (!probeBridge(installed)) return false;
  bridgeBin = installed;
  return true;
}

/** Install the bridge with the official script (sha256-verified release
 *  binary). Windows has no installer yet. Progress goes to stderr only —
 *  stdout may be a protocol channel (ACP). */
export function installBridge(): boolean {
  if (process.platform !== "linux" && process.platform !== "darwin") return false;
  console.error(`\x1b[2mInstalling TODOforAI Bridge (${INSTALLER_URL})...\x1b[0m`);
  const r = spawnSync("sh", ["-c", `curl -fsSL --connect-timeout 10 --max-time 30 ${INSTALLER_URL} | sh`],
    { stdio: ["ignore", "ignore", "inherit"], timeout: INSTALL_TIMEOUT_MS, killSignal: "SIGKILL" });
  if (r.error?.code === "ETIMEDOUT") console.error("\x1b[33mBridge install timed out\x1b[0m");
  return r.status === 0 && hasBridge();
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

export function bridgeRunArgs(apiUrl: string): string[] {
  const url = parseApiUrl(apiUrl);
  if (!url) return [];

  // `todoforai-bridge --port` is the bridge HTTP/WS port (80 prod, 4000 dev),
  // not the public HTTPS API port. Carry an EXPLICIT port through for any
  // self-hosted backend — `http://<host>:4000` maps directly to the bridge
  // endpoint whether <host> is loopback, a LAN/docker-gateway IP (bench runs
  // reach the host as 172.17.0.1) or a hostname. Keying this on loopback-only
  // dropped the port for every other host, so the bridge silently dialled :80
  // and the caller just saw "Isolated bridge not ready after 15s".
  if (url.hostname && url.hostname !== "api.todofor.ai") {
    const args = ["--host", url.hostname];
    if (url.port) args.push("--port", url.port);
    return withProfile(args, apiUrl);
  }

  // Production defaults to api.todofor.ai:80 internally.
  return [];
}

// No --port here: `login --port` is the Noise RPC port (4100 / dev 14100),
// not the HTTP port bridgeRunArgs carries; the bridge picks it from the host.
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
  const r = spawnSync(bridgeBin, bridgeWhoamiArgs(apiUrl), { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const m = (r.stdout || "").match(/^Device:.*\(id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/im);
  return m ? m[1] : null;
}

/** Enroll the bridge without a second browser round-trip: the CLI's API key
 *  mints a single-use enrollment token, `login --token` redeems it. */
async function enrollBridgeWithApiKey(apiUrl: string, apiKey: string): Promise<boolean> {
  if (apiKey.startsWith("dst_")) return false;  // device-session tokens may not mint (backend denies)
  let token: string;
  try {
    const res = await fetch(`${apiUrl}${restBasePath(apiKey)}/cli/enroll/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { console.error(`\x1b[33mBridge enroll: mint failed (${res.status})\x1b[0m`); return false; }
    token = (await res.json()).token;
  } catch (e: any) {
    console.error(`\x1b[33mBridge enroll: mint failed (${e?.message || e})\x1b[0m`);
    return false;
  }
  const login = spawnSync(bridgeBin, [...bridgeLoginArgs(apiUrl), "--token", token],
    { stdio: ["ignore", "ignore", "inherit"], timeout: 30_000, killSignal: "SIGKILL" });
  return login.status === 0;
}

export function ensureBridgeCredentials(apiUrl: string, opts: { interactive?: boolean } = {}): boolean {
  const whoami = spawnSync(bridgeBin, bridgeWhoamiArgs(apiUrl), { stdio: "ignore" });
  if (whoami.status === 0) return true;
  // stdio is a protocol channel for some callers (ACP) — never run the interactive login there.
  if (opts.interactive === false) {
    console.error("Bridge credentials not found. Run `todoforai-bridge login` first.");
    return false;
  }

  // Do not hide the bridge's first-run device-login URL in bridge.log. Run the
  // login subcommand in the foreground once, then spawn the daemon detached.
  console.error("\x1b[2mBridge credentials not found. Starting `todoforai-bridge login`...\x1b[0m");
  const login = spawnSync(bridgeBin, bridgeLoginArgs(apiUrl), { stdio: "inherit" });
  return login.status === 0;
}


type BridgeState = "online" | "offline" | "unknown";

async function bridgeState(apiUrl: string, apiKey: string, deviceId: string): Promise<BridgeState> {
  try {
    const devices = await new ApiClient(apiUrl, apiKey).listDevices();
    return Array.isArray(devices) && devices.some(device => device.id === deviceId && device.status === "ONLINE")
      ? "online"
      : "offline";
  } catch {
    return "unknown";
  }
}

async function waitForBridgeOnline(apiUrl: string, apiKey: string, deviceId: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await bridgeState(apiUrl, apiKey, deviceId);
    if (state !== "offline") return state === "online";
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  return false;
}

export async function ensureBridgeRunning(apiUrl: string, apiKey: string, opts: { interactive?: boolean } = {}): Promise<boolean> {
  if (!hasBridge() && !installBridge()) {
    console.error(`\x1b[2mBridge not started: \`todoforai-bridge\` was not found on PATH. Install it (curl -fsSL ${INSTALLER_URL} | sh), or pass --no-bridge (or deprecated --no-edge) to silence this.\x1b[0m`);
    return false;
  }

  const hasCreds = spawnSync(bridgeBin, bridgeWhoamiArgs(apiUrl), { stdio: "ignore" }).status === 0
    || (await enrollBridgeWithApiKey(apiUrl, apiKey))
    || ensureBridgeCredentials(apiUrl, opts);
  if (!hasCreds) {
    console.error("\x1b[33mBridge not started: `todoforai-bridge login` did not complete successfully.\x1b[0m");
    return false;
  }

  const deviceId = bridgeDeviceId(apiUrl);
  if (!deviceId) {
    console.error("\x1b[33mBridge not started: could not determine this device's id.\x1b[0m");
    return false;
  }
  const initialState = await bridgeState(apiUrl, apiKey, deviceId);
  // If this token cannot query devices, preserve the previous best-effort
  // behavior instead of spawning a duplicate daemon on every CLI invocation.
  if (initialState === "online" || initialState === "unknown") return initialState === "online";

  const logDir = path.join(os.homedir(), ".todoforai");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "bridge.log");
  const out = fs.openSync(logFile, "a");

  const child = spawn(bridgeBin, bridgeRunArgs(apiUrl), {
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

  if (!child.pid) return false;
  if (await waitForBridgeOnline(apiUrl, apiKey, deviceId)) return true;

  const shortLog = logFile.replace(os.homedir(), "~");
  const reason = exited ? `exit ${exitCode}` : "startup timed out";
  console.error(`\x1b[33mBridge not ready (${reason}), see ${shortLog}\x1b[0m`);
  return false;
}
