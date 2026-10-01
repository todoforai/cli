/** Codex CLI rollout reader — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 *
 * Record types: `session_meta` (cwd, session_id), `response_item` (the conversation:
 * message / function_call / custom_tool_call / *_output / reasoning), `event_msg`,
 * `turn_context`, `token_usage_record`. `developer` messages and `<tag>…</tag>`-only
 * user parts (environment_context, recommended_plugins, …) are harness noise and skipped.
 * Titles come from `~/.codex/session_index.jsonl` (`thread_name`) when present.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { type ExternalSession, type SessionMessage, noteToolCall, noteToolResult, hashContent, titleFromMessages } from "./common";

export const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

export function listCodexSessionFiles(home = codexHome()): string[] {
  const root = join(home, "sessions");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** session id → thread_name from session_index.jsonl (last write wins). */
export function readCodexTitles(home = codexHome()): Map<string, string> {
  const titles = new Map<string, string>();
  const idx = join(home, "session_index.jsonl");
  if (!existsSync(idx)) return titles;
  for (const line of readFileSync(idx, "utf8").split("\n")) {
    try { const r = JSON.parse(line); if (r?.id && typeof r.thread_name === "string") titles.set(r.id, r.thread_name); } catch { /* skip */ }
  }
  return titles;
}

/** Harness-injected user parts Codex prepends to turns; nothing a human typed. */
const HARNESS_TAGS = ["environment_context", "recommended_plugins", "user_instructions", "permissions_instructions", "turn_aborted", "collaboration_mode_instructions"];
const isHarnessBlock = (s: string) => {
  const m = /^\s*<([a-z_]+)>[\s\S]*<\/\1>\s*$/.exec(s);
  return !!m && HARNESS_TAGS.includes(m[1]);
};

const partsText = (content: unknown, dropHarness = false): string =>
  Array.isArray(content)
    ? content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(t => t.trim() && !(dropHarness && isHarnessBlock(t))).join("\n\n")
    : typeof content === "string" ? content : "";

const outputText = (output: unknown): string => {
  if (typeof output === "string") {
    // Outputs are often a JSON-encoded content array.
    try { const parsed = JSON.parse(output); if (Array.isArray(parsed)) return partsText(parsed); } catch { /* plain text */ }
    return output;
  }
  return partsText(output);
};

export function parseCodexSession(path: string, titles = readCodexTitles()): ExternalSession | null {
  const raw = readFileSync(path, "utf8");
  const messages: SessionMessage[] = [];
  let cwd: string | undefined;
  let sessionId: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    const timestamp = Number.isNaN(ts) ? undefined : ts;
    if (r.type === "session_meta") {
      cwd = cwd || r.payload?.cwd;
      sessionId = sessionId || r.payload?.session_id || r.payload?.id;
      continue;
    }
    if (r.type !== "response_item") continue;
    const p = r.payload ?? {};
    switch (p.type) {
      case "message": {
        if (p.role !== "user" && p.role !== "assistant") break;
        const content = partsText(p.content, p.role === "user").trim();
        if (content) messages.push({ role: p.role, content, timestamp });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        let input: unknown = p.arguments ?? p.input;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* raw string */ } }
        messages.push({ role: "assistant", content: noteToolCall(p.name, input), timestamp });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
        messages.push({ role: "assistant", content: noteToolResult(outputText(p.output), false), timestamp });
        break;
      default: break; // reasoning, etc.
    }
  }
  if (!cwd || !messages.some(m => m.role === "user")) return null;
  const st = statSync(path);
  return {
    kind: "codex", path, cwd, messages,
    title: (sessionId && titles.get(sessionId)?.trim()) || titleFromMessages(messages),
    sha256: hashContent(raw), modifiedAt: st.mtimeMs,
  };
}
