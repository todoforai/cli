import { renderDiff } from "../src/diff-view";

const original = `import { useState, useEffect } from "react";
import { ApiClient } from "./api";

const DEFAULT_TIMEOUT = 5000;

export function fetchData(url: string, opts?: RequestInit) {
  const client = new ApiClient(url);
  const timeout = opts?.timeout || DEFAULT_TIMEOUT;
  return client.get("/data", { timeout });
}

export function formatResult(data: any): string {
  if (!data) return "<empty>";
  return JSON.stringify(data, null, 2);
}
`;

const modified = `import { useState, useEffect } from "react";
import { ApiClient } from "./api";
import { Logger } from "./logger";

const DEFAULT_TIMEOUT = 10000;
const MAX_RETRIES = 3;

export async function fetchData(url: string, opts?: RequestInit) {
  const logger = new Logger("fetch");
  const client = new ApiClient(url);
  const timeout = opts?.timeout || DEFAULT_TIMEOUT;
  logger.info(\`Fetching \${url} with timeout=\${timeout}\`);
  return client.get("/data", { timeout, retries: MAX_RETRIES });
}

export function formatResult(data: any): string {
  if (!data) return "<empty>";
  const pretty = JSON.stringify(data, null, 2);
  return \`Result (len=\${pretty.length}):\\n\${pretty}\`;
}
`;

process.stderr.write(renderDiff(original, modified, "src/api-client.ts"));
