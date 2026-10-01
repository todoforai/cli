/** Claude Code session reader — port of Codex's `external-agent-migration/sessions/records_cla.rs`.
 *
 * Source: `~/.claude/projects/<slug>/<uuid>.jsonl`, one JSON record per line.
 * Only `user`/`assistant` records are turns; `isMeta`/`isSidechain` are skipped.
 * Tool calls/results are flattened to bracketed notes so the transcript stays readable.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { type ExternalSession, type SessionMessage, noteToolCall, noteToolResult, hashContent, titleFromMessages } from "./common";

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export function listClaudeSessionFiles(home = claudeHome()): string[] {
  const root = join(home, "projects");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const slug of readdirSync(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const dir = join(root, slug.name);
    for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) files.push(join(dir, f));
  }
  return files;
}

const parseTs = (r: any): number | undefined => {
  if (typeof r.timestamp === "string") { const t = Date.parse(r.timestamp); if (!Number.isNaN(t)) return t; }
  if (typeof r.timestamp_ms === "number") return r.timestamp_ms;
  return undefined;
};

const stripUserQuery = (s: string) => {
  const m = s.match(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/);
  return m ? m[1] : s;
};

/** Slash-command echoes and local-command transcripts the CLI writes as "user" records. */
const isHarnessUserText = (s: string) => /^\s*<(command-name|local-command-caveat|local-command-stdout|local-command-stderr|system-reminder)>/.test(s);

/** Flatten `message.content` (string | block[]) to text; `onlyToolResults` flags a
 *  user record that carries nothing but tool_result blocks (rendered as assistant). */
function flattenContent(content: unknown): { text: string; onlyToolResults: boolean } {
  if (typeof content === "string") return { text: content, onlyToolResults: false };
  if (!Array.isArray(content)) return { text: "", onlyToolResults: false };
  const parts: string[] = [];
  let toolResults = 0;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text": if (typeof b.text === "string" && b.text.trim()) parts.push(b.text); break;
      case "tool_use": parts.push(noteToolCall(b.name, b.input)); break;
      case "tool_result": {
        toolResults++;
        const inner = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? b.content.map((c: any) => (c?.type === "text" ? c.text : `[${c?.type ?? "block"}]`)).join("\n") : "";
        parts.push(noteToolResult(inner, b.is_error === true));
        break;
      }
      case "thinking": case "redacted_thinking": break;
      default: parts.push(`[external unsupported block: ${b.type}]`);
    }
  }
  return { text: parts.join("\n\n"), onlyToolResults: toolResults > 0 && toolResults === content.length };
}

export function parseClaudeSession(path: string): ExternalSession | null {
  const raw = readFileSync(path, "utf8");
  const messages: SessionMessage[] = [];
  let cwd: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof r.cwd === "string" && r.cwd) cwd = r.cwd;
    if (r.type === "custom-title" && typeof r.customTitle === "string") customTitle = r.customTitle;
    if (r.type === "ai-title" && typeof r.aiTitle === "string") aiTitle = r.aiTitle;
    if (r.type !== "user" && r.type !== "assistant") continue;
    if (r.isMeta === true || r.isSidechain === true) continue;
    const { text, onlyToolResults } = flattenContent(r.message?.content);
    const role = r.type === "user" && !onlyToolResults ? "user" : "assistant";
    const content = (role === "user" ? stripUserQuery(text) : text).trim();
    if (!content || (role === "user" && isHarnessUserText(content))) continue;
    messages.push({ role, content, timestamp: parseTs(r) });
  }
  if (!cwd || !messages.some(m => m.role === "user")) return null;
  const st = statSync(path);
  return {
    kind: "claude", path, cwd, messages,
    title: customTitle?.trim() || aiTitle?.trim() || titleFromMessages(messages),
    sha256: hashContent(raw), modifiedAt: st.mtimeMs,
  };
}
