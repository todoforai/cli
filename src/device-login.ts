/** Browser-based device login. Prints the URL + code on stderr, opens the
 *  browser, polls until approved, persists the key. Shared by `login`, the
 *  first-run prompt, and the ACP `authenticate` method. */

import { spawn } from "child_process";
import { ApiClient } from "@shared/api";
import { writeCredential } from "./credentials";
import { BRIGHT_WHITE, CYAN, GREEN, RED, RESET } from "./colors";

export class DeviceLoginError extends Error {}

export async function runDeviceLogin(apiUrl: string): Promise<string> {
  const loginApi = new ApiClient(apiUrl, ""); // no key needed for init
  // clientName "edge" → backend mints a durable apiKey (handled below); "cli"/"bridge"
  // route to the device-credential branch that returns device/apiToken (no apiKey).
  const { code, url, expiresIn } = await loginApi.initDeviceLogin("edge");

  const userCode = new URL(url).searchParams.get("user_code") || code.slice(-8).toUpperCase();
  const formattedCode = userCode.length === 8 ? `${userCode.slice(0, 4)}-${userCode.slice(4)}` : userCode;
  process.stderr.write(`\n🔑 Open this URL to authorize:\n`);
  process.stderr.write(`${CYAN}${url}${RESET}\n`);
  process.stderr.write(`Verification code: ${BRIGHT_WHITE}${formattedCode}${RESET}\n\n`);

  // Best-effort open browser
  try {
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no opener (headless box): the URL is printed anyway
    child.unref();
  } catch {}

  process.stderr.write(`Waiting for approval (expires in ${Math.round(expiresIn / 60)}min)...\n`);
  const deadline = Date.now() + expiresIn * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const poll = await loginApi.pollDeviceLogin(code);
      failures = 0;
      if (poll.status === "complete" && poll.apiKey) {
        writeCredential(apiUrl, poll.apiKey);
        process.stderr.write(`${GREEN}✅ Login successful! API key saved.${RESET}\n`);
        return poll.apiKey;
      }
      if (poll.status === "expired") break;
    } catch (e: any) {
      if (++failures >= 5) throw new DeviceLoginError(`Poll failed: ${e.message}`);
    }
  }
  throw new DeviceLoginError("Login expired or failed.");
}
