/** Read-only todo inspection — print full chat log */

import { CYAN, DIM, GREEN, YELLOW, RED, BOLD, RESET } from "./colors";

export function printFullChat(todo: any, frontendUrl: string) {
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
  process.stderr.write("─".repeat(60) + "\n");

  const messages = todo.messages || [];
  if (!messages.length) {
    process.stderr.write(`${DIM}(no messages)${RESET}\n`);
    return;
  }

  for (const msg of messages) {
    const roleLabel = msg.role === "user" ? `${CYAN}▶ USER${RESET}` : `${GREEN}◀ ASSISTANT${RESET}`;
    process.stderr.write(`\n${roleLabel} ${DIM}${new Date(msg.createdAt).toLocaleTimeString()}${RESET}\n`);

    if (msg.content) {
      const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + `\n${DIM}... (${msg.content.length} chars total)${RESET}` : msg.content;
      process.stdout.write(content + "\n");
    }

    for (const block of msg.blocks || []) {
      const blockStatusColor = block.status === "COMPLETED" ? GREEN : block.status === "ERROR" || block.status === "DENIED" ? RED : YELLOW;
      process.stderr.write(`\n  ${YELLOW}[${block.type}]${RESET} ${blockStatusColor}${block.status}${RESET}`);
      for (const key of ["path", "cmd", "name", "server_name", "tool_name"]) {
        if (block[key]) process.stderr.write(` ${DIM}${key}=${RESET}${block[key]}`);
      }
      process.stderr.write("\n");

      if (block.content) {
        const content = block.content.length > 500 ? block.content.slice(0, 500) + `\n${DIM}... (${block.content.length} chars)${RESET}` : block.content;
        process.stdout.write(`  ${DIM}│${RESET} ${content.split("\n").join(`\n  ${DIM}│${RESET} `)}\n`);
      }
      if (block.result) {
        const result = block.result.length > 500 ? block.result.slice(0, 500) + `\n${DIM}... (${block.result.length} chars)${RESET}` : block.result;
        process.stderr.write(`  ${DIM}└─ result:${RESET} ${result.split("\n").join(`\n  ${DIM}│${RESET}  `)}\n`);
      }
      if (block.error_message) {
        process.stderr.write(`  ${RED}└─ error: ${block.error_message}${RESET}\n`);
      }
      if (block.stacktrace) {
        process.stderr.write(`  ${DIM}${block.stacktrace.slice(0, 300)}${block.stacktrace.length > 300 ? "..." : ""}${RESET}\n`);
      }
    }
  }

  process.stderr.write("\n" + "─".repeat(60) + "\n");
  const blockCount = messages.reduce((n: number, m: any) => n + (m.blocks?.length || 0), 0);
  const errorBlocks = messages.reduce((n: number, m: any) => n + (m.blocks || []).filter((b: any) => b.status === "ERROR" || b.type === "error").length, 0);
  process.stderr.write(`${DIM}Messages: ${messages.length} | Blocks: ${blockCount} | Errors: ${errorBlocks}${RESET}\n`);
}
