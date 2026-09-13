/** `todoforai-cli acp` — Agent Client Protocol adapter (JSON-RPC over stdio).
 *
 * Lets ACP hosts (Zed, JetBrains, …) spawn this CLI as an agent and get native
 * streaming, diff review and permission prompts. Pure translation layer: one
 * ACP session = one todo; the backend drives tools/approvals/diffs over the
 * same frontend WebSocket `watch.ts` consumes. stdout is the RPC channel — all
 * diagnostics go to stderr.
 */

import { realpathSync } from "fs";
import { Readable, Writable } from "stream";
import * as acp from "@zed-industries/agent-client-protocol";
import { ApiClient, FrontendWebSocket } from "@shared/api";
import { getBlockNewPatterns } from "@shared/fbe/permissionUtils";
import { NEVER_SCHEDULED_TIMESTAMP } from "@shared/fbe";
import { autoCreateAgent } from "./agent";
import { ensureBridgeRunning } from "./ensure-bridge";
import { getItemId, resolveAgentMatch } from "./select";
import { classifyBlock } from "./watch";

const log = (...a: any[]) => process.stderr.write(`[acp] ${a.join(" ")}\n`);

type SessionUpdate = acp.SessionNotification["update"];
type ToolContent = Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"];
type Session = { todoId: string; projectId: string; agent: any; turn?: Turn };
type Turn = { cancelled: boolean; started: boolean; done: boolean };

const ACP_KIND: Record<string, acp.ToolKind> = { create: "edit", edit: "edit", read: "read", search: "search", shell: "execute" };

const toolTitle = (info: any) => {
  const target = info.path || info.filePath || info.cmd || info.name || info.url || info.query || "";
  return target ? `${info.block_type || "tool"}: ${String(target).slice(0, 120)}` : info.block_type || "tool";
};

/** ACP `tool_call_update.content` REPLACES the collection, so keep the full
 *  per-block content (diff + accumulated output) and resend it on change. */
class BlockView {
  info: Record<string, any> = {};
  announced = false;
  permissionAsked = false;
  output = "";

  content(): ToolContent {
    const c: NonNullable<ToolContent> = [];
    if (this.info.originalContent !== undefined || this.info.modifiedContent !== undefined) {
      c.push({ type: "diff", path: this.info.path || this.info.filePath || "file", oldText: this.info.originalContent ?? null, newText: this.info.modifiedContent ?? "" });
    }
    if (this.output) c.push({ type: "content", content: { type: "text", text: this.output } });
    return c;
  }
}

class TodoforaiAgent implements acp.Agent {
  private sessions = new Map<string, Session>();

  constructor(private conn: acp.AgentSideConnection, private api: ApiClient, private ws: FrontendWebSocket, private projectId: string | undefined, private agentQuery: string | undefined) {}

  async initialize(): Promise<acp.InitializeResponse> {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { promptCapabilities: { embeddedContext: true } }, authMethods: [] };
  }

  async authenticate(): Promise<void> {}

  /** Same rule as the non-interactive paths in index.ts: explicit > server default > first. */
  private async resolveProject(): Promise<string> {
    if (this.projectId) return this.projectId;
    const projects = await this.api.listProjects();
    const id = projects.find((p: any) => p.project?.isDefault)?.project?.id || (projects[0] && getItemId(projects[0]));
    if (!id) throw acp.RequestError.internalError("no project on this account");
    return (this.projectId = id);
  }

  /** --agent wins; else the agent owning this workspace; else create one for it. */
  private async resolveAgent(cwd: string) {
    if (this.agentQuery) {
      const { match, ambiguous } = resolveAgentMatch(await this.api.listAgentSettings(), this.agentQuery);
      if (!match) throw acp.RequestError.invalidParams(`agent '${this.agentQuery}' ${ambiguous?.length ? "is ambiguous" : "not found"}`);
      return match;
    }
    return (await this.api.listAgentSettings({ workspacePath: cwd }))[0] ?? (await autoCreateAgent(this.api, cwd));
  }

  async newSession(p: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const projectId = await this.resolveProject();
    const cwd = realpathSync(p.cwd);
    const agent = await this.resolveAgent(cwd);
    const todoId = crypto.randomUUID();
    this.sessions.set(todoId, { todoId, projectId, agent });
    log(`session ${todoId} agent=${agent.name} cwd=${cwd}`);
    return { sessionId: todoId };
  }

  async cancel(p: acp.CancelNotification): Promise<void> {
    const s = this.sessions.get(p.sessionId);
    if (!s?.turn || s.turn.done) return;
    s.turn.cancelled = true;
    if (s.turn.started && !(await this.ws.sendInterrupt(s.projectId, s.todoId))) log("interrupt not delivered (socket down)");
  }

  async prompt(p: acp.PromptRequest): Promise<acp.PromptResponse> {
    const s = this.sessions.get(p.sessionId);
    if (!s) throw acp.RequestError.invalidParams(`unknown session ${p.sessionId}`);
    if (s.turn && !s.turn.done) throw acp.RequestError.invalidRequest("a prompt is already running in this session");
    const turn: Turn = (s.turn = { cancelled: false, started: false, done: false });

    const text = p.prompt.map(b =>
      b.type === "text" ? b.text
      : b.type === "resource_link" ? `@${b.uri}`
      : b.type === "resource" && "text" in b.resource ? `\n<file path="${b.resource.uri}">\n${b.resource.text}\n</file>\n`
      : "").join("");

    const sessionId = p.sessionId;
    const update = (u: SessionUpdate) => this.conn.sessionUpdate({ sessionId, update: u }).catch(e => log("update failed", e?.message));
    const blocks = new Map<string, BlockView>();
    const view = (id: string) => blocks.get(id) ?? blocks.set(id, new BlockView()).get(id)!;

    const announce = (id: string, b: BlockView) => {
      if (b.announced) return;
      b.announced = true;
      const path = b.info.path || b.info.filePath;
      void update({ sessionUpdate: "tool_call", toolCallId: id, title: toolTitle(b.info), kind: ACP_KIND[classifyBlock(b.info)] ?? "other", status: "pending", locations: path ? [{ path }] : [], rawInput: { block_type: b.info.block_type, cmd: b.info.cmd, path, changes: b.info.changes } });
    };

    const askPermission = async (id: string, b: BlockView, messageId: string) => {
      if (b.permissionAsked || turn.done) return;
      b.permissionAsked = true;
      const patterns = getBlockNewPatterns({ type: b.info.block_type || "unknown", generalized_pattern: b.info.generalized_pattern, cmd: b.info.cmd }, s.agent?.permissions);
      const options: acp.PermissionOption[] = [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        ...(patterns.length ? [{ optionId: "allow_remember", name: `Always allow ${patterns.map(x => x.replace(/^todoai_(edge|cloud):/, "")).join(", ")}`, kind: "allow_always" as const }] : []),
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ];
      try {
        const res = await this.conn.requestPermission({ sessionId, toolCall: { toolCallId: id }, options });
        const choice = res.outcome.outcome === "selected" ? res.outcome.optionId : "deny";
        if (turn.cancelled || turn.done) return;
        const ok = choice === "allow_once" || choice === "allow_remember"
          ? await this.ws.sendBlockApproval(s.todoId, messageId, id, choice, choice === "allow_remember" ? patterns : undefined)
          : await this.ws.sendBlockDeny(s.todoId, messageId, id);
        if (!ok) log(`approval for ${id} not delivered (socket down)`);
      } catch (e: any) {
        log("permission request failed", e?.message);
      }
    };

    const onEvent = (type: string, payload: any) => {
      if (type === "block:message") {
        if (payload.content) void update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: payload.content } });
        return;
      }
      if (!payload.blockId) return;
      const id = payload.blockId;
      const b = view(id);

      if (type.startsWith("block:start_")) {
        b.info = { ...b.info, ...payload };
        return;
      }
      if (type === "block:sh_msg_result") {
        // Edge-internal marker (pre-write file snapshot, see agent transport.jl) — not user output.
        const text = String(payload.content || "").split("\n").filter(l => !l.startsWith("TFA_SNAPSHOT:")).join("\n");
        if (!text.trim()) return;
        b.output += text;
        announce(id, b);
        void update({ sessionUpdate: "tool_call_update", toolCallId: id, content: b.content() });
        return;
      }
      if (type !== "BLOCK_UPDATE") return;

      const u = payload.updates || {};
      b.info = { ...b.info, ...u };
      announce(id, b);
      const st = u.status;
      const status: acp.ToolCallStatus | undefined = st === "RUNNING" ? "in_progress" : st === "COMPLETED" ? "completed" : ["DENIED", "FAILED", "ERROR"].includes(st) ? "failed" : undefined;
      const contentChanged = u.originalContent !== undefined || u.modifiedContent !== undefined;
      if (status || contentChanged || u.result) {
        void update({ sessionUpdate: "tool_call_update", toolCallId: id, ...(status && { status }), ...(contentChanged && { content: b.content() }), ...(u.result && { rawOutput: { result: u.result } }) });
      }
      if (st === "AWAITING_APPROVAL") void askPermission(id, b, payload.messageId);
    };

    // Post the message as manual-start (PAUSED), subscribe (server-acked), THEN
    // start it — so no event is emitted before we listen. A cancel that lands
    // before start never starts the run; one that lands during start interrupts.
    try {
      const msg = await this.api.addMessage(s.projectId, text, s.agent, s.todoId, undefined, NEVER_SCHEDULED_TIMESTAMP);
      // The previous turn's trailing terminal status (DONE lands ~1s after READY)
      // arrives after that turn's forget() and is cached as a stale "early" result;
      // completion() would consume it and end this turn before any output. The
      // todo is PAUSED from here on, so nothing terminal can be emitted until start.
      this.ws.forget(s.todoId);
      if (!(await this.ws.subscribe(s.todoId, onEvent))) throw new Error("subscribe failed");
      const done = this.ws.completion(s.todoId);
      if (turn.cancelled) return { stopReason: "cancelled" };
      await this.api.updateAndStart(s.todoId, s.agent, msg.messages?.at(-1)?.id);
      turn.started = true;
      if (turn.cancelled) await this.ws.sendInterrupt(s.projectId, s.todoId);
      const result = await done;
      if (turn.cancelled || /^CANCELLED/.test(result?.payload?.status)) return { stopReason: "cancelled" };
      if (!result?.success) throw acp.RequestError.internalError(`todo ended with status ${result?.payload?.status ?? "unknown"}`);
      return { stopReason: "end_turn" };
    } catch (e: any) {
      if (e instanceof acp.RequestError) throw e;
      throw acp.RequestError.internalError(String(e?.message || e));
    } finally {
      turn.done = true;
      this.ws.forget(s.todoId);
    }
  }
}

export async function runAcp(apiUrl: string, apiKey: string, opts: { projectId?: string; agent?: string; noBridge?: boolean }) {
  // Shared libs log via console.log; anything on stdout would corrupt the RPC stream.
  console.log = (...a: any[]) => process.stderr.write(a.map(String).join(" ") + "\n");

  const api = new ApiClient(apiUrl, apiKey);
  const ws = new FrontendWebSocket(apiUrl, apiKey);
  const [wsOk] = await Promise.all([ws.connect(), opts.noBridge || ensureBridgeRunning(apiUrl, apiKey, { interactive: false })]);
  if (!wsOk) throw new Error("frontend websocket connect failed");

  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  new acp.AgentSideConnection(conn => new TodoforaiAgent(conn, api, ws, opts.projectId, opts.agent), stream);
  log(`ready (${apiUrl})`);
  await new Promise<void>(resolve => { process.stdin.once("end", resolve); process.stdin.once("close", resolve); process.stdin.once("error", resolve); });
  await ws.close();
}
