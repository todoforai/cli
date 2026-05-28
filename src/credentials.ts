/**
 * Shared credentials store. Path matches edge/bridge and tfa-* tools:
 *   Windows: %APPDATA%\todoforai\credentials.json
 *   macOS:   ~/Library/Application Support/todoforai/credentials.json
 *   Linux:   $XDG_CONFIG_HOME/todoforai/credentials.json (default ~/.config)
 *
 * Format: { "<apiUrl>": "<apiKey>", ... } — URL-keyed token map.
 * The same file may also contain bridge fields (apiToken, deviceId, …) written by
 * the edge; we only touch the URL-keyed entries here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir, platform } from "os";

function credentialsPath(): string {
  const sys = platform();
  if (sys === "win32") return join(homedir(), "AppData", "Roaming", "todoforai", "credentials.json");
  if (sys === "darwin") return join(homedir(), "Library", "Application Support", "todoforai", "credentials.json");
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "todoforai", "credentials.json");
}

const CREDENTIALS_PATH = credentialsPath();

function read(): Record<string, any> {
  if (!existsSync(CREDENTIALS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8")) as Record<string, any>;
  } catch {
    return {};
  }
}

export function readCredential(apiUrl: string): string {
  const v = read()[apiUrl];
  return typeof v === "string" ? v : "";
}

export function writeCredential(apiUrl: string, apiKey: string): void {
  const data = read();
  data[apiUrl] = apiKey;
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export { CREDENTIALS_PATH };
