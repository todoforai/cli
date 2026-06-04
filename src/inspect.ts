/** Read-only todo inspection — print full chat log */

import { CYAN, DIM, GREEN, YELLOW, RED, BOLD, RESET } from "./colors";

export type InspectMode = "default" | "detailed" | "debug";
export type InspectFormat = "compact" | "anthropic";

/** Escape value for an XML-tag-style attribute. We use JSON.stringify so
 *  newlines, quotes, etc. are stable and re-parseable. */
const xmlAttr = (v: any) => JSON.stringify(String(v));

/** Drop noise from inspect --json output by mode.
 *  default: chat-shape only — assistant text/tool calls/results, user content.
 *  detailed: + block/message ids, timestamps, agentSettingsId, scheduledTimestamp.
 *  debug:   + runMeta (cost/tokens), generationCompleted, userId, deviceId, runMode.
 */
const DROP_IF_EMPTY = new Set(["runMeta", "meta", "attachments", "blocks"]);
const ALWAYS_DROP = new Set(["messageIds", "data"]);
// Kept only in --detailed and --debug (not in default).
const DETAILED_ONLY = new Set([
  "id", "createdAt", "lastActivityAt", "modifiedAt",
  "agentSettingsId", "scheduledTimestamp", "workflowVersion",
  "todoId", "blockId", "parentBlockId",
  "stop_sequence", "permissions", "isPublic", "metadata",
]);
// Kept only in --debug.
const DEBUG_ONLY = new Set([
  "runMeta", "generationCompleted",
  "userId", "deviceId", "runMode",
]);
const isEmpty = (x: any) =>
  (Array.isArray(x) && x.length === 0) ||
  (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 0);

export function pruneEmpty(v: any, mode: InspectMode = "default"): any {
  if (Array.isArray(v)) return v.map(x => pruneEmpty(x, mode));
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, raw] of Object.entries(v)) {
      if (ALWAYS_DROP.has(k)) continue;
      if (DEBUG_ONLY.has(k) && mode !== "debug") continue;
      if (DETAILED_ONLY.has(k) && mode === "default") continue;
      if (raw === "") continue;
      if (k === "scheduledTimestamp" && (raw === 0 || raw === 1)) continue;
      if (DROP_IF_EMPTY.has(k) && isEmpty(raw)) continue;
      o[k] = pruneEmpty(raw, mode);
    }
    return o;
  }
  return v;
}

/** Map a backend block to one or two content items.
 *  - text/reason → `text`/`thinking` item.
 *  - tool blocks → `tool_use` (+ adjacent `tool_result` if there are results).
 *
 *  Format:
 *    compact:   tool_use.content = '<bash cmd="..."/>',
 *               tool_result.content = '<attachment uri="..."/>' string.
 *    anthropic: tool_use.{id,name,input} + tool_result.{tool_use_id,content:blocks[]}
 *               per the Anthropic API spec. (Caller is responsible for moving
 *               tool_result into the next user message.)
 */
// Backend block keys that are *not* part of a tool's logical input — drop these when
// constructing tool_use.input so every real input field (cmd/path/prompt/pattern/changes/…)
// comes through automatically.
const BLOCK_META_KEYS = new Set([
  "type", "id", "parentBlockId", "toolCallId",
  "status", "results", "content", "modifiedContent", "originalContent",
  "error_message", "stacktrace",
  "runMeta", "runMode", "generationCompleted", "userId", "deviceId",
]);

function blockToAnthropic(block: any, mode: InspectMode, format: InspectFormat): any[] {
  const t = block.type;
  if (t === "text") return [{ type: "text", text: block.content ?? "" }];
  if (t === "reason") return [{ type: "thinking", thinking: block.content ?? "" }];
  if (t === "error") {
    const msg = block.error_message || block.content || "(unknown error)";
    return [{ type: "text", text: `[error] ${msg}` }];
  }

  // Build the tool_use. Take every backend field that isn't pure metadata.
  const inputFields: [string, any][] = [];
  for (const [k, v] of Object.entries(block)) {
    if (BLOCK_META_KEYS.has(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    inputFields.push([k, v]);
  }
  const use: any = format === "anthropic"
    ? { type: "tool_use", id: block.id, name: t, input: Object.fromEntries(inputFields) }
    : { type: "tool_use", content: `<${t}${inputFields.map(([k, v]) => ` ${k}=${xmlAttr(v)}`).join("")}/>` };
  if (format === "compact" && mode !== "default") use.id = block.id;

  // Build the tool_result, if any.
  const items: any[] = [use];
  if (block.results?.length) {
    if (format === "anthropic") {
      const content = block.results.flatMap((r: any) => {
        const parts: any[] = [];
        for (const att of r.attachments ?? []) {
          const isImage = (att.mimeType || "").startsWith("image/");
          const isAutoName = /^(bash|read|list|explore|edit|write|grep):/.test(att.originalName ?? "");
          const source: any = { type: "uri", uri: att.uri, mimeType: att.mimeType, size: att.fileSize };
          if (att.originalName && !isAutoName) source.name = att.originalName;
          parts.push({ type: isImage ? "image" : "document", source });
        }
        if (typeof r.content === "string" && r.content) parts.push({ type: "text", text: r.content });
        return parts;
      });
      const result: any = { type: "tool_result", tool_use_id: block.id };
      if (content.length) result.content = content;
      if (block.status && block.status !== "COMPLETED") result.is_error = true;
      items.push(result);
    } else {
      const parts: string[] = [];
      for (const r of block.results) {
        for (const att of r.attachments ?? []) {
          const isAutoName = /^(bash|read|list|explore|edit|write|grep):/.test(att.originalName ?? "");
          const nameAttr = att.originalName && !isAutoName ? ` name=${xmlAttr(att.originalName)}` : "";
          parts.push(`<attachment uri=${xmlAttr(att.uri)}${nameAttr} size=${att.fileSize}/>`);
        }
        if (typeof r.content === "string" && r.content) parts.push(r.content);
      }
      const result: any = { type: "tool_result", content: parts.join("\n") };
      if (mode !== "default") result.tool_use_id = block.id;
      if (block.status && block.status !== "COMPLETED") result.status = block.status;
      items.push(result);
    }
  }
  return items;
}

/** Convert backend `messages[]` to Anthropic-style messages with content-block arrays (B-shape).
 *  Tool calls and their results stay inside the same assistant message, in chronological order.
 *  Backend auto-appends tool-output attachments to the next user message; we drop those here
 *  to avoid showing them twice (in the tool_result AND on the user). */
export function toAnthropicShape(
  messages: any[],
  mode: InspectMode = "default",
  format: InspectFormat = "compact",
): any[] {
  const out: any[] = [];
  let prevToolAttachmentIds = new Set<string>();
  for (const m of messages) {
    const msg: any = { role: m.role };
    if (mode !== "default") {
      if (m.id) msg.id = m.id;
      if (m.createdAt) msg.createdAt = m.createdAt;
    }
    if (m.role === "user") {
      const atts = (m.attachments ?? [])
        .filter((a: any) => !prevToolAttachmentIds.has(a.id))
        .map((a: any) => {
          const isImage = (a.mimeType || "").startsWith("image/");
          return {
            type: isImage ? "image" : "document",
            source: { type: "uri", uri: a.uri, name: a.originalName, mimeType: a.mimeType, size: a.fileSize },
          };
        });
      // If the user message has no real content AND all its attachments were tool outputs
      // (already shown in the previous assistant's tool_result), skip it entirely.
      const hadAttachments = (m.attachments ?? []).length > 0;
      if (!m.content && hadAttachments && atts.length === 0 && mode === "default") {
        prevToolAttachmentIds = new Set();
        continue;
      }
      if (atts.length === 0) {
        msg.content = m.content ?? "";
      } else {
        msg.content = [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...atts,
        ];
      }
      out.push(pruneEmpty(msg, mode));
      prevToolAttachmentIds = new Set();
      continue;
    }
    // assistant: flatten blocks into content[]. Accumulate tool-output attachment IDs so the
    // next user message can drop the backend's auto-fed duplicates (may span several
    // assistant turns before the next user message).
    const content: any[] = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const b of m.blocks ?? []) {
      for (const r of b.results ?? []) {
        for (const a of r.attachments ?? []) if (a.id) prevToolAttachmentIds.add(a.id);
      }
    }
    for (const b of m.blocks ?? []) content.push(...blockToAnthropic(b, mode, format));

    if (format === "anthropic") {
      // Split: tool_use stays on assistant, tool_result moves to a synthetic next user message.
      const useItems = content.filter((c: any) => c.type !== "tool_result");
      const resultItems = content.filter((c: any) => c.type === "tool_result");
      msg.content = useItems;
      if (mode === "debug" && m.runMeta?.length) msg.runMeta = m.runMeta;
      out.push(pruneEmpty(msg, mode));
      if (resultItems.length) {
        out.push(pruneEmpty({ role: "user", content: resultItems }, mode));
      }
    } else {
      msg.content = content;
      if (mode === "debug" && m.runMeta?.length) msg.runMeta = m.runMeta;
      out.push(pruneEmpty(msg, mode));
    }
  }
  return out;
}

/** Python-style slice on an array length. Accepts `N`, `N:`, `:N`, `N:M` with negatives. */
export function applySlice<T>(arr: T[], spec: string): T[] {
  if (!spec.includes(":")) {
    const i = Number(spec);
    if (!Number.isInteger(i)) throw new Error(`Bad slice: '${spec}'`);
    const r = arr.at(i);
    return r === undefined ? [] : [r];
  }
  const parts = spec.split(":");
  if (parts.length !== 2) throw new Error(`Bad slice: '${spec}' (use N, N:, :N, or N:M)`);
  const [a, b] = parts;
  const start = a === "" ? 0 : Number(a);
  const end = b === "" ? arr.length : Number(b);
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`Bad slice: '${spec}'`);
  return arr.slice(start, end);
}

const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n) + `\n${DIM}... (${s.length} chars)${RESET}` : s;
const indent = (s: string, pre: string) => s.split("\n").join(`\n${pre}`);

export function printFullChat(todo: any, frontendUrl: string, slice?: string, mode: InspectMode = "default", format: InspectFormat = "compact") {
  const statusColors: Record<string, string> = {
    DONE: GREEN, READY: GREEN, READY_CHECKED: GREEN,
    ERROR: RED, ERROR_CHECKED: RED, CANCELLED: RED, CANCELLED_CHECKED: RED,
    RUNNING: YELLOW, STOPPING: YELLOW, TODO: CYAN,
  };
  const statusColor = statusColors[todo.status] || DIM;

  process.stderr.write(`${BOLD}TODO${RESET} ${todo.id}\n`);
  process.stderr.write(`${DIM}Status:${RESET} ${statusColor}${todo.status}${RESET}\n`);
  process.stderr.write(`${DIM}URL:${RESET}    ${CYAN}${frontendUrl}${RESET}\n`);
  process.stderr.write(`${DIM}Created:${RESET} ${new Date(todo.createdAt).toLocaleString()}\n`);
  if (todo.agentSettingsId) process.stderr.write(`${DIM}Agent:${RESET}  ${todo.agentSettingsId}\n`);
  if (slice) process.stderr.write(`${DIM}Slice:${RESET}  [${slice}]\n`);
  process.stderr.write("─".repeat(60) + "\n");

  let messages = todo.messages || [];
  if (slice) {
    try { messages = applySlice(messages, slice); }
    catch (e: any) { process.stderr.write(`${RED}${e.message}${RESET}\n`); process.exit(2); }
  }
  if (!messages.length) {
    process.stderr.write(`${DIM}(no messages)${RESET}\n`);
    return;
  }

  // Render from the canonical Anthropic shape (single source of truth shared with --json).
  const shaped = toAnthropicShape(messages, mode, format);
  let toolUseCount = 0, errorCount = 0;

  for (let i = 0; i < shaped.length; i++) {
    const msg = shaped[i];
    const orig = messages[i];
    const ts = orig?.createdAt ? ` ${DIM}${new Date(orig.createdAt).toLocaleTimeString()}${RESET}` : "";
    const label = msg.role === "user" ? `${CYAN}▶ USER${RESET}` : `${GREEN}◀ ASSISTANT${RESET}`;
    process.stderr.write(`\n${label}${ts}\n`);

    const items = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
    for (const it of items) {
      if (it.type === "text") {
        if (it.text) process.stdout.write(trunc(it.text, 2000) + "\n");
      } else if (it.type === "image" || it.type === "document") {
        const s = it.source ?? {};
        process.stderr.write(`  ${YELLOW}[${it.type}]${RESET} ${DIM}${s.mimeType ?? ""}${RESET} ${s.name ?? ""} ${DIM}(${s.size ?? "?"} bytes)${RESET}\n  ${DIM}${s.uri ?? ""}${RESET}\n`);
      } else if (it.type === "thinking") {
        if (it.thinking) process.stderr.write(`${DIM}[thinking]${RESET} ${trunc(it.thinking, 500)}\n`);
      } else if (it.type === "tool_use") {
        toolUseCount++;
        if (it.content) {
          // compact format: '<name attr="..."/>' — show as-is, just truncated.
          process.stderr.write(`  ${YELLOW}${trunc(it.content, 200)}${RESET}\n`);
        } else {
          // anthropic format: structured name+input.
          const argStr = Object.entries(it.input || {}).map(([k, v]) => `${DIM}${k}=${RESET}${String(v).split("\n")[0].slice(0, 80)}`).join(" ");
          process.stderr.write(`  ${YELLOW}[${it.name}]${RESET} ${argStr}\n`);
        }
      } else if (it.type === "tool_result") {
        const errLabel = it.is_error ? ` ${RED}ERROR${RESET}` : it.status && it.status !== "COMPLETED" ? ` ${RED}${it.status}${RESET}` : "";
        if (errLabel) errorCount++;
        const status = errLabel;
        let bodyStr: string;
        if (typeof it.content === "string") bodyStr = it.content;
        else {
          // anthropic format: render each content block compactly.
          bodyStr = (it.content || []).map((c: any) => {
            if (c.type === "text") return c.text ?? "";
            if (c.type === "image" || c.type === "document") {
              const s = c.source ?? {};
              return `[${c.type}] ${s.mimeType ?? ""}${s.name ? " "+s.name : ""} (${s.size ?? "?"} B) ${s.uri ?? ""}`;
            }
            return "";
          }).join("\n");
        }
        process.stderr.write(`  ${DIM}└─ result:${RESET}${status} ${indent(trunc(bodyStr, 500), `     ${DIM}│${RESET} `)}\n`);
      }
    }
  }

  process.stderr.write("\n" + "─".repeat(60) + "\n");
  process.stderr.write(`${DIM}Messages: ${shaped.length} | Tool calls: ${toolUseCount} | Tool errors: ${errorCount}${RESET}\n`);
}
