/** Watch todo execution and handle block approvals — port of watch.py */

import { FrontendWebSocket } from "todoforai-edge/src/frontend-ws";
import { singleChar } from "./select";
import { getBlockPatterns } from "@shared/fbe/bashPatterns";

// ANSI color codes
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

// ── block classification ─────────────────────────────────────────────

function classifyBlock(info: any): string {
  const btype: string = info.type || "";
  const bp = info.payload || {};
  const inner = (bp.block_type || "").toLowerCase();
  if (btype.includes("createfile") || ["create", "createfile"].includes(inner)) return "file";
  if (btype.includes("modifyfile") || ["modify", "modifyfile", "update"].includes(inner)) return "file";
  if (btype.includes("catfile") || ["catfile", "read", "readfile"].includes(inner)) return "read";
  if (btype.includes("mcp") || inner === "mcp") return "mcp";
  if (btype.includes("shell") || ["shell", "bash"].includes(inner) || bp.cmd) return "shell";
  return "unknown";
}

function blockDisplay(info: any): [string, string] {
  const labels: Record<string, string> = { file: "File", read: "Read File", mcp: "MCP", shell: "Shell" };
  const bp = info.payload || {};
  const kind = classifyBlock(info);
  const typeLabel = labels[kind] || bp.block_type || "Tool";
  const skipKeys = new Set(["userId", "messageId", "todoId", "blockId", "block_type", "edge_id", "timeout"]);
  const knownKeys = new Set(["path", "filePath", "content", "cmd", "name"]);

  let display = bp.path || bp.filePath || bp.content || bp.cmd || bp.name || "";
  const rest = Object.entries(bp).filter(([k, v]) => !skipKeys.has(k) && !knownKeys.has(k) && v);
  if (rest.length) {
    const extra = rest.map(([k, v]) => `${k}=${v}`).join(" ");
    display = display ? `${display} (${extra})` : extra;
  }
  if (!display) display = "<pending>";
  if (display.length > 200) display = display.slice(0, 200) + "...";
  return [typeLabel, display];
}

// ── approval helpers ─────────────────────────────────────────────────

function sendApproval(ws: FrontendWebSocket, blockId: string, messageId: string, todoId: string, decision: string = "allow_once", patterns?: string[]): void {
  const payload: any = { todoId, messageId, blockId, decision };
  if (patterns && patterns.length > 0) {
    payload.patterns = patterns;
  }
  (ws as any).ws?.send(JSON.stringify({
    type: "BLOCK_APPROVAL_INTENT",
    payload,
  }));
}

// ── main watch function ──────────────────────────────────────────────

export interface WatchOpts {
  json?: boolean;
  autoApprove?: boolean;
  agentSettings?: any;
  interruptOnCancel?: boolean;
  suppressCancelNotice?: boolean;
  activityEvent?: { set(): void };
  /** Messages buffered during callback handoff to replay before watching. */
  replayMessages?: Array<[string, any]>;
}

export async function watchTodo(
  ws: FrontendWebSocket,
  todoId: string,
  projectId: string,
  timeout: number,
  opts: WatchOpts = {},
): Promise<boolean> {
  const ignore = new Set([
    "todo:msg_start", "todo:msg_done", "todo:msg_stop_sequence",
    "todo:msg_meta_ai", "todo:status", "todo:new_message_created",
    "block:end", "block:start_shell", "block:start_createfile",
    "block:start_modifyfile", "block:start_mcp", "block:start_catfile",
    "block:sh_msg_start", "block:sh_done",
  ]);

  const signalActivity = () => opts.activityEvent?.set();

  // Resolve edge_id + root_path from agent settings
  let edgeId: string | undefined;
  let rootPath = "";
  if (opts.agentSettings) {
    const emc = opts.agentSettings.edgesMcpConfigs || {};
    edgeId = Object.keys(emc)[0];
    if (edgeId) {
      const ec = emc[edgeId];
      const tc = ec?.todoai_edge || ec?.todoai || {};
      rootPath = (tc.workspacePaths || [])[0] || "";
    }
  }

  let approveAll = !!opts.autoApprove;
  let interruptCount = 0;

  // Set up Ctrl+C handler
  const origHandler = process.listeners("SIGINT").slice();
  process.removeAllListeners("SIGINT");
  process.on("SIGINT", () => {
    interruptCount++;
    if (interruptCount >= 2) {
      process.stderr.write(`\n${RED}Force exit (double Ctrl+C)${RESET}\n`);
      process.exit(130);
    }
    process.stderr.write(`\n${YELLOW}Interrupting... (Ctrl+C again to force exit)${RESET}\n`);
    if (opts.interruptOnCancel !== false) {
      ws.sendInterrupt(projectId, todoId);
    }
  });

  // Pending approval blocks
  const pendingBlocks: any[] = [];
  let approvalPromptActive = false;

  async function handleApprovals() {
    if (approvalPromptActive || pendingBlocks.length === 0) return;
    approvalPromptActive = true;

    const blocks = pendingBlocks.splice(0);

    if (approveAll) {
      for (const bi of blocks) {
        const [tl, disp] = blockDisplay(bi);
        process.stderr.write(`\n${YELLOW}⚠ Auto-approving [${tl}]${RESET} ${disp}\n`);
        sendApproval(ws, bi.blockId, bi.messageId, todoId);
      }
      approvalPromptActive = false;
      return;
    }

    process.stderr.write(`\n${YELLOW}⚠ ${blocks.length} action(s) awaiting approval:${RESET}\n`);
    for (const bi of blocks) {
      const [tl, disp] = blockDisplay(bi);
      process.stderr.write(`  ${YELLOW}[${tl}]${RESET} ${disp}\n`);
      const ctx = bi.approvalContext || {};
      const installs = ctx.toolInstalls || [];
      if (installs.length) {
        process.stderr.write(`  ${CYAN}↳ Install tools: ${installs.join(", ")}${RESET}\n`);
      }
    }

    try {
      const response = await singleChar("  [Y]es / [n]o / [a]ll / [r]emember? ");
      if (response === "a") {
        approveAll = true;
      }
      if (response === "a" || response === "y" || response === "" || response === "r") {
        const decision = response === "r" ? "allow_remember" : "allow_once";
        for (const bi of blocks) {
          let patterns: string[] | undefined;
          if (response === "r") {
            // Compute patterns from block payload
            const bp = bi.payload || {};
            patterns = getBlockPatterns({
              type: bi.type || bp.block_type || "unknown",
              generalized_pattern: bi.generalized_pattern,
              cmd: bp.cmd,
            });
            if (patterns.length > 0) {
              process.stderr.write(`  ${GREEN}✓ Remembering: ${patterns.join(", ")}${RESET}\n`);
            }
          }
          sendApproval(ws, bi.blockId, bi.messageId, todoId, decision, patterns);
        }
      } else {
        for (const bi of blocks) {
          ws.sendBlockDeny(todoId, bi.messageId, bi.blockId);
        }
        process.stderr.write(`  ${RED}✗ Denied${RESET}\n`);
      }
    } catch {
      // Interrupted — auto-approve
      for (const bi of blocks) {
        sendApproval(ws, bi.blockId, bi.messageId, todoId);
      }
    }
    approvalPromptActive = false;
  }

  const callback = (msgType: string, payload: any) => {
    if (msgType === "block:message") {
      process.stdout.write(payload.content || "");
      signalActivity();
    } else if (msgType === "BLOCK_UPDATE") {
      const updates = payload.updates || {};
      const status = updates.status;
      const result = updates.result;
      if (result) {
        process.stderr.write(`\n${DIM}--- Block Result ---\n${result}${RESET}\n`);
        signalActivity();
      } else if (status === "AWAITING_APPROVAL") {
        pendingBlocks.push(payload);
        handleApprovals();
        signalActivity();
      } else if (status && status !== "COMPLETED" && status !== "RUNNING") {
        process.stderr.write(`\n[block:update] status=${status}\n`);
        signalActivity();
      }
    } else if (msgType === "block:start_universal") {
      const skip = new Set(["userId", "messageId", "todoId", "blockId", "block_type", "edge_id", "timeout"]);
      const blockType = payload.block_type || "UNIVERSAL";
      const parts = Object.entries(payload)
        .filter(([k]) => !skip.has(k))
        .map(([k, v]) => `${k}=${v}`);
      const extra = parts.length ? ` ${parts.join(" ")}` : "";
      process.stderr.write(`\n${YELLOW}*${RESET} ${YELLOW}${blockType}${RESET}${extra}\n`);
      signalActivity();
    } else if (msgType === "block:sh_msg_result") {
      const content = payload.content || "";
      if (content) {
        const lines = content.trim().split("\n");
        const preview = lines.slice(0, 4).map((l: string) => `  ${DIM}│${RESET} ${l}`).join("\n");
        const extra = lines.length > 4 ? `\n  ${DIM}│ +${lines.length - 4} lines${RESET}` : "";
        process.stderr.write(`${preview}${extra}\n`);
        signalActivity();
      }
    } else if (!ignore.has(msgType)) {
      process.stderr.write(`\n[${msgType}]\n`);
      signalActivity();
    }
  };

  // Replay any messages buffered during callback handoff
  if (opts.replayMessages) {
    for (const [msgType, payload] of opts.replayMessages) {
      callback(msgType, payload);
    }
  }

  try {
    const result = await ws.waitForCompletion(todoId, callback, timeout);
    process.stdout.write("\n");
    if (!result?.success) {
      const t = result?.type || "unknown";
      process.stderr.write(`Warning: Stopped: ${t}\n`);
    }
    return true;
  } catch (e: any) {
    if (e.message?.includes("Timeout")) {
      process.stderr.write(`\nTimeout after ${timeout}s\n`);
      process.exit(1);
    }
    if (!opts.suppressCancelNotice) {
      process.stderr.write(`${YELLOW}Interrupted${RESET}\n`);
    }
    return false;
  } finally {
    // Restore SIGINT handlers
    process.removeAllListeners("SIGINT");
    for (const fn of origHandler) process.on("SIGINT", fn as any);
  }
}
