/** Spawn a detached edge daemon if none is running. */

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

function hasBunx(): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["bunx"], { stdio: "ignore" });
  return probe.status === 0;
}

export function ensureEdgeRunning(apiUrl: string, apiKey: string) {
  if (!hasBunx()) {
    console.error("\x1b[2mEdge daemon not started: `bunx` is missing. Install Bun from https://bun.sh to enable it, or pass --no-edge to silence this.\x1b[0m");
    return;
  }

  const logDir = path.join(os.homedir(), ".todoforai");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "edge.log");
  const out = fs.openSync(logFile, "a");

  const child = spawn("bunx", ["@todoforai/edge", "--api-url", apiUrl, "--api-key", apiKey], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.on("error", (err) => {
    console.error(`\x1b[33mFailed to start edge daemon: ${err.message}\x1b[0m`);
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
      console.error(`\x1b[2mStarted edge daemon (pid ${pid}), logs: ${shortLog}\x1b[0m`);
      return;
    }
    if (exitCode === 0) {
      console.error(`\x1b[2mEdge daemon exited cleanly (another instance likely already running). Logs: ${shortLog}\x1b[0m`);
    } else {
      console.error(`\x1b[31mEdge daemon died (exit ${exitCode}). Check logs: ${shortLog}\x1b[0m`);
    }
  }, 500);
}
