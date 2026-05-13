/** Spawn a detached edge daemon if none is running. */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

export function ensureEdgeRunning(apiUrl: string, apiKey: string) {
  const logDir = path.join(os.homedir(), ".todoforai");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "edge.log");
  const out = fs.openSync(logFile, "a");

  const child = spawn("bunx", ["@todoforai/edge", "--api-url", apiUrl, "--api-key", apiKey], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  const pid = child.pid;
  setTimeout(() => {
    try {
      process.kill(pid!, 0);
      console.error(`\x1b[2mStarted edge daemon (pid ${pid}), logs: ${logFile.replace(os.homedir(), "~")}\x1b[0m`);
    } catch {
      // Already exited — likely another edge is running (lock held). Silent.
    }
  }, 500);
}
