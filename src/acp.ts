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
import * as acp from "@agentclientprotocol/sdk";
import { ApiClient, FrontendWebSocket } from "@shared/api";
import { getBlockNewPatterns } from "@shared/fbe/permissionUtils";
import { NEVER_SCHEDULED_TIMESTAMP } from "@shared/fbe";
import { autoCreateAgent } from "./agent";
import { ensureBridgeRunning } from "./ensure-bridge";
import { getItemId, resolveAgentMatch } from "./select";
import { classifyBlock } from "./watch";
import { runDeviceLogin } from "./device-login";

const log = (...a: any[]) => process.stderr.write(`[acp] ${a.join(" ")}\n`);

type SessionUpdate = acp.SessionNotification["update"];
type ToolContent = Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"];
type Session = { todoId: string; projectId: string; agent: any; turn?: Turn };
type Turn = { cancelled: boolean; started: boolean; done: boolean };

const ACP_KIND: Record<string, acp.ToolKind> = { create: "edit", edit: "edit", read: "read", search: "search", shell: "execute" };

const toolTitle = (info: any) => {
  const target = info.path || info.filePath || info.cmd || info.name || info.url || info.query || "";
  if (target) return `${info.block_type || "tool"}: ${String(target).split("\n")[0].slice(0, 120)}`;
  return info.title || info.block_type || "tool";
};

/** ACP `tool_call_update.content` REPLACES the collection, so keep the full
 *  per-block content (diff + accumulated output) and resend it on change. */
class BlockView {
  info: Record<string, any> = {};
  announced = false;
  permissionAsked = false;
  title = "";
  kind: acp.ToolKind = "other";
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

/** Device login as an ACP "agent" auth method: the CLI opens the browser and
 *  polls for approval itself, then connects the backend socket + bridge. */
/** No `type` = "agent" auth per the ACP registry docs: the agent runs the flow itself. */
const AUTH_METHOD: acp.AuthMethod = { id: "device-login", name: "Log in with TODOforAI", description: "Opens your browser to authorize this machine" };

class TodoforaiAgent implements acp.Agent {
  private sessions = new Map<string, Session>();
  private api!: ApiClient;
  private ws!: FrontendWebSocket; // set by connect(); every RPC that uses it goes through requireAuth()
  // Memoized so concurrent authenticate / session/new calls share one login
  // and one socket; reset on failure so the host can retry.
  private loggingIn?: Promise<void>;
  private connecting?: Promise<void>;

  constructor(private conn: acp.AgentSideConnection, private apiUrl: string, private apiKey: string, private opts: { projectId?: string; agent?: string; noBridge?: boolean }) {}

  async initialize(): Promise<acp.InitializeResponse> {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { promptCapabilities: { embeddedContext: true } }, authMethods: [AUTH_METHOD] };
  }

  async authenticate(p: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    if (p.methodId !== AUTH_METHOD.id) throw acp.RequestError.invalidParams(`unknown auth method ${p.methodId}`);
    if (!this.apiKey) {
      await (this.loggingIn ??= runDeviceLogin(this.apiUrl)
        .then(key => { this.apiKey = key; })
        .finally(() => { this.loggingIn = undefined; }));
    }
    await this.connect();
    return {};
  }

  /** Backend socket + local bridge; once per process, after a key exists. */
  connect(): Promise<void> {
    return (this.connecting ??= (async () => {
      const ws = new FrontendWebSocket(this.apiUrl, this.apiKey);
      try {
        const [wsOk] = await Promise.all([ws.connect(), this.opts.noBridge || ensureBridgeRunning(this.apiUrl, this.apiKey, { interactive: false })]);
        if (!wsOk) throw acp.RequestError.internalError("frontend websocket connect failed");
      } catch (e) {
        this.connecting = undefined;
        await ws.close().catch(() => {});
        throw e;
      }
      this.api = new ApiClient(this.apiUrl, this.apiKey);
      this.ws = ws;
      log(`ready (${this.apiUrl})`);
    })());
  }

  private async requireAuth() {
    if (!this.apiKey) throw acp.RequestError.authRequired();
    await this.connect();
  }

  async close() { await (this.ws as FrontendWebSocket | undefined)?.close(); }

  /** Same rule as the non-interactive paths in index.ts: explicit > server default > first. */
  private async resolveProject(): Promise<string> {
    if (this.opts.projectId) return this.opts.projectId;
    const projects = await this.api.listProjects();
    const id = projects.find((p: any) => p.project?.isDefault)?.project?.id || (projects[0] && getItemId(projects[0]));
    if (!id) throw acp.RequestError.internalError("no project on this account");
    return (this.opts.projectId = id);
  }

  /** --agent wins; else the agent owning this workspace; else create one for it. */
  private async resolveAgent(cwd: string) {
    if (this.opts.agent) {
      const { match, ambiguous } = resolveAgentMatch(await this.api.listAgentSettings(), this.opts.agent);
      if (!match) throw acp.RequestError.invalidParams(`agent '${this.opts.agent}' ${ambiguous?.length ? "is ambiguous" : "not found"}`);
      return match;
    }
    return (await this.api.listAgentSettings({ workspacePath: cwd }))[0] ?? (await autoCreateAgent(this.api, cwd));
  }

  /** Agent settings are exposed as ACP session modes: the host renders them as
   *  a picker next to the chat input, so the user can switch without editing
   *  the `--agent` arg. */
  private async modes(current: any): Promise<acp.SessionModeState> {
    const agents: any[] = await this.api.listAgentSettings();
    if (!agents.some(a => a.id === current.id)) agents.unshift(current);
    return {
      currentModeId: current.id,
      availableModes: agents.map(a => ({ id: a.id, name: a.name || a.id, description: a.model || null })),
    };
  }

  async newSession(p: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    await this.requireAuth();
    const projectId = await this.resolveProject();
    const cwd = realpathSync(p.cwd);
    const agent = await this.resolveAgent(cwd);
    const todoId = crypto.randomUUID();
    this.sessions.set(todoId, { todoId, projectId, agent });
    log(`session ${todoId} agent=${agent.name} cwd=${cwd}`);
    return { sessionId: todoId, modes: await this.modes(agent) };
  }

  async setSessionMode(p: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    const s = this.sessions.get(p.sessionId);
    if (!s) throw acp.RequestError.invalidParams(`unknown session ${p.sessionId}`);
    const agent = (await this.api.listAgentSettings()).find((a: any) => a.id === p.modeId);
    if (!agent) throw acp.RequestError.invalidParams(`unknown agent ${p.modeId}`);
    s.agent = agent; // applies from the next prompt; a running turn keeps its agent
    log(`session ${s.todoId} agent=${agent.name}`);
    void this.conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: agent.id } });
    return {};
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

    // Block metadata streams in pieces (a status-only BLOCK_UPDATE can precede
    // block:start_* with block_type/cmd), so announce once and then patch
    // title/kind as they settle. Text blocks stream as agent_message_chunk.
    const announce = (id: string, b: BlockView) => {
      if (b.info.block_type === "text") return;
      const title = toolTitle(b.info), kind = ACP_KIND[classifyBlock(b.info)] ?? "other";
      const path = b.info.path || b.info.filePath;
      if (!b.announced) {
        b.announced = true;
        void update({ sessionUpdate: "tool_call", toolCallId: id, title, kind, status: "pending", locations: path ? [{ path }] : [], rawInput: { block_type: b.info.block_type, cmd: b.info.cmd, path, changes: b.info.changes } });
      } else if (title !== b.title || kind !== b.kind) {
        void update({ sessionUpdate: "tool_call_update", toolCallId: id, title, kind, ...(path && { locations: [{ path }] }) });
      }
      b.title = title; b.kind = kind;
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
        announce(id, b);
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
      const st = u.status;
      if (!b.info.block_type && !st) return; // routing-only update (target/cwd) precedes block:start_*
      announce(id, b);
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

  // Listen for host EOF before anything async, so a host that goes away during
  // the eager connect below still ends this process.
  const eof = new Promise<void>(resolve => { process.stdin.once("end", resolve); process.stdin.once("close", resolve); process.stdin.once("error", resolve); });
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  let agent!: TodoforaiAgent;
  new acp.AgentSideConnection(conn => (agent = new TodoforaiAgent(conn, apiUrl, apiKey, opts)), stream);
  // Connect eagerly when already logged in so the first session/new is instant;
  // otherwise wait for the host to call authenticate.
  if (apiKey) agent.connect().catch(e => log("connect failed:", e?.message));
  else log("not logged in — waiting for authenticate");
  await eof;
  await agent.close();
}
