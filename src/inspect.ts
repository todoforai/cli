/** Read-only todo inspection — print full chat log */

import { CYAN, DIM, GREEN, YELLOW, RED, BOLD, RESET } from "./colors";

export type InspectMode = "default" | "detailed" | "debug";

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
  "todoId", "blockId", "parentBlockId", "messageIds",
  "stop_sequence", "permissions", "isPublic", "metadata",
]);
// Kept only in --debug.
const DEBUG_ONLY = new Set([
  "runMeta", "generationCompleted",
  "userId", "deviceId", "runMode", "long",
  "timeout",
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

/** Map a backend block to one or two Anthropic-style content items.
 *  - text/reason → single `text`/`thinking` item.
 *  - tool blocks (bash/read/list/explore/...) → `tool_use` + adjacent `tool_result`.
 */
function blockToAnthropic(block: any, mode: InspectMode): any[] {
  const t = block.type;
  if (t === "text") return [{ type: "text", text: block.content ?? "" }];
  if (t === "reason") return [{ type: "thinking", thinking: block.content ?? "" }];

  // tool_use: name = block type, input = the type-specific fields we know about.
  const input: any = {};
  for (const k of ["cmd", "path", "prompt", "long"]) if (block[k] !== undefined) input[k] = block[k];
  const use: any = { type: "tool_use", name: t, input };
  if (mode !== "default") use.id = block.id;

  // tool_result: collapse `results[]` (attachments + inline text) into a single content string/array.
  const items: any[] = [use];
  if (block.results?.length) {
    const content = block.results.flatMap((r: any) => {
      const out: any[] = [];
      for (const att of r.attachments ?? []) {
        out.push({
          type: "text",
          text: `<attachment uri="${att.uri}" name="${att.originalName}" size=${att.fileSize}/>`,
        });
      }
      if (typeof r.content === "string" && r.content) out.push({ type: "text", text: r.content });
      return out;
    });
    const result: any = { type: "tool_result", content: content.length === 1 && content[0].type === "text" ? content[0].text : content };
    if (mode !== "default") result.tool_use_id = block.id;
    if (block.status && block.status !== "COMPLETED") result.status = block.status;
    items.push(result);
  }
  return items;
}

/** Convert backend `messages[]` to Anthropic-style messages with content-block arrays (B-shape).
 *  Tool calls and their results stay inside the same assistant message, in chronological order. */
export function toAnthropicShape(messages: any[], mode: InspectMode = "default"): any[] {
  return messages.map((m: any) => {
    const out: any = { role: m.role };
    if (mode !== "default") {
      if (m.id) out.id = m.id;
      if (m.createdAt) out.createdAt = m.createdAt;
    }
    if (m.role === "user") {
      const atts = (m.attachments ?? []).map((a: any) => {
        const isImage = (a.mimeType || "").startsWith("image/");
        return {
          type: isImage ? "image" : "document",
          source: { type: "uri", uri: a.uri, name: a.originalName, mimeType: a.mimeType, size: a.fileSize },
        };
      });
      if (atts.length === 0) {
        out.content = m.content ?? "";
      } else {
        out.content = [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...atts,
        ];
      }
      return pruneEmpty(out, mode);
    }
    // assistant: flatten blocks into content[].
    const content: any[] = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const b of m.blocks ?? []) content.push(...blockToAnthropic(b, mode));
    out.content = content;
    if (mode === "debug" && m.runMeta?.length) out.runMeta = m.runMeta;
    return pruneEmpty(out, mode);
  });
}

/** Python-style slice on an array length. Accepts `N`, `N:`, `:N`, `N:M` with negatives. */
export function applySlice<T>(arr: T[], spec: string): T[] {
  if (!spec.includes(":")) {
    const i = Number(spec);
    if (!Number.isInteger(i)) throw new Error(`Bad slice: '${spec}'`);
    const r = arr.at(i);
    return r === undefined ? [] : [r];
  }
  const [a, b] = spec.split(":", 2);
  const start = a === "" ? 0 : Number(a);
  const end = b === "" ? arr.length : Number(b);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Bad slice: '${spec}'`);
  return arr.slice(start, end);
}

const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n) + `\n${DIM}... (${s.length} chars)${RESET}` : s;
const indent = (s: string, pre: string) => s.split("\n").join(`\n${pre}`);

export function printFullChat(todo: any, frontendUrl: string, slice?: string, mode: InspectMode = "default") {
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
  const shaped = toAnthropicShape(messages, mode);
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
        const argStr = Object.entries(it.input || {}).map(([k, v]) => `${DIM}${k}=${RESET}${String(v).split("\n")[0].slice(0, 80)}`).join(" ");
        process.stderr.write(`  ${YELLOW}[${it.name}]${RESET} ${argStr}\n`);
      } else if (it.type === "tool_result") {
        const status = it.status && it.status !== "COMPLETED" ? ` ${RED}${it.status}${RESET}` : "";
        if (status) errorCount++;
        const body = typeof it.content === "string"
          ? it.content
          : (it.content || []).map((c: any) => c.text ?? "").join("\n");
        process.stderr.write(`  ${DIM}└─ result:${RESET}${status} ${indent(trunc(body, 500), `     ${DIM}│${RESET} `)}\n`);
      }
    }
  }

  process.stderr.write("\n" + "─".repeat(60) + "\n");
  process.stderr.write(`${DIM}Messages: ${shaped.length} | Tool calls: ${toolUseCount} | Tool errors: ${errorCount}${RESET}\n`);
}
