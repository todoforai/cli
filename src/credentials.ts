/**
 * Shared credentials store: ~/.todoforai/credentials.json
 *
 * Format: { "<apiUrl>": "<apiKey>", ... }
 *
 * Used by `todoforai-subagent`, `todoforai login` (edge), and this CLI.
 * Keep formats compatible — do not change shape without updating all consumers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

const CREDENTIALS_PATH = join(homedir(), ".todoforai", "credentials.json");

function read(): Record<string, string> {
  if (!existsSync(CREDENTIALS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function readCredential(apiUrl: string): string {
  return read()[apiUrl] || "";
}

export function writeCredential(apiUrl: string, apiKey: string): void {
  const data = read();
  data[apiUrl] = apiKey;
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export { CREDENTIALS_PATH };
