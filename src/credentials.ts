/**
 * Client credentials store — re-exported from the shared @shared/credentials
 * package (single source of truth across all TODOforAI CLIs). The store path,
 * both token shapes (URL-keyed + top-level apiToken/apiKey bridge fields) and the
 * device-session refresh all live there. This barrel keeps the CLI's local import
 * sites stable.
 */

import { hostname, platform, release, userInfo } from "os";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { writeCredential, writeCredentials, readStoredAuth } from "@shared/credentials";
import type { DeviceLoginPoll } from "@shared/api";

export { readCredential, writeCredential, refreshDeviceToken } from "@shared/credentials";

/** Sanitize this host's name into a backend-acceptable device name. Returns
 *  undefined when nothing usable remains, so the backend picks the next `pc_N`. */
export function defaultDeviceName(): string | undefined {
  const n = hostname().replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[-_]+/, "").slice(0, 64);
  return n || undefined;
}

/** Stable per-host id, matching what the C bridge sends (Linux /etc/machine-id,
 *  macOS IOPlatformUUID, Windows MachineGuid). The backend dedupes device rows on
 *  it, so a CLI login on a host the bridge already enrolled reuses that row
 *  instead of creating a phantom one. "" when unavailable. */
function machineId(): string {
  try {
    if (platform() === "linux") {
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try { return readFileSync(p, "utf-8").trim(); } catch {}
      }
      return "";
    }
    if (platform() === "darwin") {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf-8" });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? "";
    }
    if (platform() === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf-8" });
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? "";
    }
  } catch {}
  return "";
}

/** Host description sent with a device login, same shape the bridge reports. */
export function hostIdentity(): Record<string, unknown> {
  const id = machineId();
  return {
    os: platform(),
    kernel: release(),
    hostname: hostname(),
    deviceType: "PC",
    user: userInfo().username,
    ...(id ? { machine_id: id } : {}),
  };
}

/**
 * Which login the backend should mint for `apiUrl`.
 *
 * "bridge" enrolls a device and returns deviceId + deviceSecret + a dst_ session
 * token — the same identity `todoforai-bridge login` would create, so the bridge
 * this CLI spawns is already logged in and either side can re-mint the token.
 * That is what we want, but the credentials store has a single top-level device
 * slot: logging in against a *different* backend would overwrite it, and since
 * enrolling rotates the secret server-side it would also break that backend's
 * bridge. In that case ask for a plain apiKey instead, which lives safely under
 * its own URL-keyed entry (the pre-device-flow behaviour).
 */
export function loginClientName(apiUrl: string): "bridge" | "edge" {
  const stored = readStoredAuth(apiUrl);
  if (!stored.deviceId || !stored.apiUrl) return "bridge";
  return new URL(stored.apiUrl).hostname === new URL(apiUrl).hostname ? "bridge" : "edge";
}

/** Persist a completed device login and return the token to use, or "" if the
 *  response carried neither device credentials nor an apiKey. */
export function persistLogin(apiUrl: string, poll: DeviceLoginPoll): string {
  if (poll.device && poll.apiToken) {
    // Top-level fields only — never URL-keyed: a dst_ token expires, and only the
    // top-level `apiToken` is what refreshDeviceToken re-mints. A stale URL-keyed
    // copy would shadow it forever (readCredential prefers the URL key).
    writeCredentials({
      deviceId: poll.device.id,
      deviceSecret: poll.device.secret,
      deviceName: poll.device.name,
      apiToken: poll.apiToken,
      // Canonical apiUrl keeps scheme + port for self-hosted/dev backends;
      // backendHost is what the C bridge reads.
      apiUrl,
      backendHost: new URL(apiUrl).hostname,
      ...(poll.user ? { userId: poll.user.id, userEmail: poll.user.email, ...(poll.user.name ? { userName: poll.user.name } : {}) } : {}),
    });
    return poll.apiToken;
  }
  if (poll.apiKey) {
    writeCredential(apiUrl, poll.apiKey);
    return poll.apiKey;
  }
  return "";
}
