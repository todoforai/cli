/** Shared shapes + helpers for external session importers (Claude Code, Codex).
 *  Note formats mirror Codex's importer so a transcript reads the same in either direction. */
import { createHash } from "crypto";

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface ExternalSession {
  kind: "claude" | "codex";
  /** Absolute path of the source file. */
  path: string;
  cwd: string;
  title: string;
  messages: SessionMessage[];
  sha256: string;
  modifiedAt: number;
}

const NOTE_MAX_LEN = 2000;
const TOOL_RESULT_MAX_LEN = 4000;
export const SESSION_TITLE_MAX_LEN = 120;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

export const hashContent = (s: string) => createHash("sha256").update(s).digest("hex");

/** `[external_agent_tool_call: name]` with the most descriptive input fields, like Codex renders them. */
export function noteToolCall(name: unknown, input: unknown): string {
  const lines = [`[external_agent_tool_call: ${typeof name === "string" ? name : "tool"}]`];
  const inp = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  let shown = false;
  if (inp) {
    for (const [label, keys] of [["description", ["description"]], ["command", ["command", "cmd"]], ["file", ["file_path", "path", "notebook_path"]]] as const) {
      const v = keys.map(k => inp[k]).find(x => typeof x === "string" && x);
      if (v) { lines.push(`${label}: ${clip(v as string, NOTE_MAX_LEN)}`); shown = true; }
    }
  }
  if (!shown && input !== undefined) lines.push(`input: ${clip(typeof input === "string" ? input : JSON.stringify(input), NOTE_MAX_LEN)}`);
  lines.push("[/external_agent_tool_call]");
  return lines.join("\n");
}

export function noteToolResult(output: string, isError: boolean): string {
  const head = isError ? "[external_agent_tool_result: error]" : "[external_agent_tool_result]";
  return `${head}\n${clip(output.trim(), TOOL_RESULT_MAX_LEN)}\n[/external_agent_tool_result]`;
}

/** First user line, clipped — the fallback title when the source has no explicit one. */
export function titleFromMessages(messages: SessionMessage[], fallback = "Imported session"): string {
  const first = messages.find(m => m.role === "user" && !m.content.startsWith("[external_agent_tool"))?.content ?? "";
  const line = first.split("\n").map(l => l.trim()).find(Boolean) ?? "";
  return line ? clip(line, SESSION_TITLE_MAX_LEN) : fallback;
}
