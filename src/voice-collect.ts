/**
 * `tfa-cli brand voice collect <channel>` device adapters: read the user's OWN writing through
 * the CLI they already signed into on this machine, and hand it back as VoiceSample rows
 * ({ text, prompt?, at?, url? }). `text` is always what the user wrote; `prompt` is the message
 * they answered (real, never synthesised). Same row shape as backend/bench/voice/data.
 *
 * One adapter per channel, only for CLIs we actually have:
 *   Gmail   zele        sent threads → (their message, my reply) pairs
 *   Outlook outlook-api sent items   → (their message, my reply) pairs
 *   Chat    tfa-memory  my TODO turns → (assistant turn, my message) pairs
 * X/LinkedIn/Facebook/Instagram are read server-side (crawl, Graph API, shared signed-in browser).
 * Slack is a workspace app on the backend, not a device CLI. Teams has nothing yet.
 */
import { execFileSync } from "node:child_process";

export interface VoiceSample { text: string; prompt?: string; at?: string; url?: string }
export interface CollectResult { samples: VoiceSample[]; note?: string }
interface Adapter { tool: string; check: () => string | null; collect: (max: number) => CollectResult }

const run = (bin: string, args: string[]) =>
  execFileSync(bin, args, { encoding: "utf8", maxBuffer: 256 << 20, timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
const installed = (bin: string) => { try { run("which", [bin]); return true; } catch { return false; } };
/** Shortest sample the server keeps (PublicPageFetcher.MIN_POST). */
const MIN_CHARS = 30;

// ── Gmail (zele) ─────────────────────────────────────────────────────────────

type Msg = { from: string; date: string; body: string };
const SEP = /^─{20,}$/m;
/** `zele mail read` output → messages. Header block = From/To/Date/Auth lines, then body. */
function parseThread(out: string): Msg[] {
  return out.split(SEP).slice(1).map((chunk) => {
    const lines = chunk.trim().split("\n");
    let i = 0; const h: Record<string, string> = {};
    for (; i < lines.length && /^\s*(From|To|Date|Auth|Cc):/.test(lines[i]); i++) { const [k, ...v] = lines[i].trim().split(":"); h[k] = v.join(":").trim(); }
    return { from: h.From ?? "", date: h.Date ?? "", body: lines.slice(i).join("\n").trim() };
  }).filter((m) => m.from);
}

/** Drop quoted history, "On … wrote:" attribution lines and a trailing signature. */
export function stripReply(body: string): string {
  const lines = body.split("\n");
  const cut = lines.findIndex((l, i) =>
    /^>/.test(l) ||
    /^(On .{6,}wrote:|.{3,} ezt írta \(időpont:|Le .{6,} a écrit :|Am .{6,} schrieb .*:|-----Original Message-----|From: .*|________________________________)$/i.test(l.trim()) ||
    (/^(On .{6,}|.{3,} ezt írta)/.test(l.trim()) && i + 1 < lines.length && /^>|wrote:$|\):$/.test(lines[i + 1].trim())));
  let kept = (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !/^Attachments: /.test(l)).join("\n").trim();
  kept = kept.replace(/\n--\s*\n[\s\S]*$/, "").trim();
  return kept;
}

const gmail: Adapter = {
  tool: "zele",
  check: () => {
    if (!installed("zele")) return "zele is not installed";
    const who = (() => { try { return run("zele", ["whoami"]); } catch { return ""; } })();
    return /email:/.test(who) ? null : "zele is not signed in (run: zele login --method google)";
  },
  collect: (max) => {
    const accounts = [...run("zele", ["whoami"]).matchAll(/email: (\S+)/g)].map((m) => m[1]);
    const isMe = (from: string) => accounts.some((a) => from.toLowerCase().includes(a.toLowerCase()));
    const samples: VoiceSample[] = [];
    for (const account of accounts) {
      const list = run("zele", ["mail", "search", "from:me", "--limit", String(max), "--account", account]);
      const ids = [...list.matchAll(/^  - id: ([0-9a-f]+)\n(?:.*\n)*?    messages: (\d+)/gm)].filter((m) => Number(m[2]) > 1).map((m) => m[1]);
      for (const id of ids) {
        if (samples.length >= max) break;
        const msgs = parseThread(run("zele", ["mail", "read", id, "--account", account]));
        for (let i = 1; i < msgs.length && samples.length < max; i++) {
          if (!isMe(msgs[i].from) || isMe(msgs[i - 1].from)) continue; // my reply to someone else
          const text = stripReply(msgs[i].body), prompt = stripReply(msgs[i - 1].body);
          if (text.length < MIN_CHARS || prompt.length < 20) continue;
          samples.push({ at: msgs[i].date, text, prompt, url: `gmail:${account}/${id}#${i}` });
        }
      }
    }
    return { samples, note: `${accounts.length} account(s)` };
  },
};

// ── Outlook (outlook-api) ────────────────────────────────────────────────────

type GraphMsg = { id: string; conversationId?: string; from?: { emailAddress?: { address?: string } }; sentDateTime?: string; receivedDateTime?: string; body?: { content?: string }; bodyPreview?: string; webLink?: string };

const outlook: Adapter = {
  tool: "outlook-api",
  check: () => {
    if (!installed("outlook-api")) return "outlook-api is not installed";
    try { const me = JSON.parse(run("outlook-api", ["whoami"])); return me?.mail || me?.userPrincipalName ? null : "outlook-api is not signed in"; }
    catch { return "outlook-api is not signed in (run: outlook-api auth)"; }
  },
  collect: (max) => {
    const me = JSON.parse(run("outlook-api", ["whoami"])) as { mail?: string; userPrincipalName?: string };
    const mine = [me.mail, me.userPrincipalName].filter(Boolean).map((a) => a!.toLowerCase());
    const isMe = (m: GraphMsg) => mine.includes((m.from?.emailAddress?.address ?? "").toLowerCase());
    const sent = JSON.parse(run("outlook-api", ["list", "-f", "sentitems", "-n", String(max), "--select", "id,conversationId,from,sentDateTime,webLink"])) as { value?: GraphMsg[] } | GraphMsg[];
    const sentRows = Array.isArray(sent) ? sent : sent.value ?? [];
    const samples: VoiceSample[] = [];
    const seenConv = new Set<string>();
    for (const s of sentRows) {
      if (!s.conversationId || seenConv.has(s.conversationId)) continue;
      seenConv.add(s.conversationId);
      // Whole conversation, oldest first; a reply = my message right after someone else's.
      // Graph rejects $orderby next to a $filter on messages — sort locally.
      const conv = JSON.parse(run("outlook-api", ["get", `/me/messages?$filter=conversationId eq '${s.conversationId.replace(/'/g, "''")}'&$top=50&$select=id,from,receivedDateTime,sentDateTime,webLink`])) as { value?: GraphMsg[] };
      const msgs = (conv.value ?? []).sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
      // `read` prints one JSON document per id; with --text the body is already plain.
      const body = (id: string) => stripReply((JSON.parse(run("outlook-api", ["read", id, "--text"])) as GraphMsg).body?.content ?? "");
      for (let i = 1; i < msgs.length && samples.length < max; i++) {
        if (!isMe(msgs[i]) || isMe(msgs[i - 1])) continue;
        const text = body(msgs[i].id), prompt = body(msgs[i - 1].id);
        if (text.length < MIN_CHARS || prompt.length < 20) continue;
        samples.push({ at: msgs[i].sentDateTime ?? msgs[i].receivedDateTime, text, prompt, url: msgs[i].webLink ?? `outlook:${msgs[i].id}` });
      }
      if (samples.length >= max) break;
    }
    return { samples };
  },
};

// ── Chat (tfa-memory: the user's own TODO messages) ─────────────────────────

type Row = { address: string; createdAt: number; content: string; meta?: { role?: string } };
const QUERIES = "the we you ok this that fix why do how make add run test build post code file error need want should could now more less good bad new old first last".split(" ");

const chat: Adapter = {
  tool: "tfa-memory",
  check: () => installed("tfa-memory") ? null : "tfa-memory is not installed",
  collect: (max) => {
    const mem = (...a: string[]) => run("tfa-memory", a);
    const anchors = new Map<string, string>();
    for (const q of QUERIES) {
      for (const line of mem("search", q, "--source", "todo", "--mode", "lexical", "--limit", "50").split("\n")) {
        const m = line.match(/todo\/([0-9a-f-]{36}):([0-9a-f-]{36})/);
        if (m && !anchors.has(m[1])) anchors.set(m[1], `todo/${m[1]}:${m[2]}`);
      }
      if (anchors.size >= max) break;
    }
    const samples: VoiceSample[] = [];
    for (const anchor of [...anchors.values()].slice(0, max)) {
      let msgs: Row[];
      try { msgs = JSON.parse(mem("around", anchor, "--before", "200", "--after", "200", "--json")); } catch { continue; }
      msgs.sort((a, b) => a.createdAt - b.createdAt);
      for (let i = 1; i < msgs.length; i++) {
        if (msgs[i].meta?.role !== "user" || msgs[i - 1].meta?.role === "user") continue;
        const text = msgs[i].content.trim(), prompt = msgs[i - 1].content.trim();
        if (text.length < MIN_CHARS || prompt.length < 40) continue;
        if (/^\s*(#|\/|@|\{)/.test(text)) continue;              // slash commands, pasted json: not writing
        if (text.split("\n").length > 6) continue;               // pasted logs/diffs, not the voice
        if (/^Wait w_|\nWait w_[0-9a-f]+ '|^Connected \w+ \(card\)|^\[/m.test(text)) continue; // system-injected turns
        samples.push({ at: new Date(msgs[i].createdAt).toISOString(), text, prompt: prompt.slice(0, 4000), url: msgs[i].address });
      }
    }
    return { samples: samples.slice(0, max), note: `${anchors.size} todos` };
  },
};

export const ADAPTERS: Record<string, Adapter> = { Gmail: gmail, Outlook: outlook, Chat: chat };
export const DEVICE_CHANNELS = Object.keys(ADAPTERS);

/** Is this channel readable on this device right now? null = yes, else the reason. */
export function checkChannel(channel: string): string | null {
  const a = ADAPTERS[channel];
  return a ? a.check() : `${channel} is not read on the device (server-side: pass --url, or paste)`;
}

/** Read the channel's samples; rows that do not carry a reply are dropped, never synthesised. */
export function collectChannel(channel: string, max = 40): CollectResult {
  const a = ADAPTERS[channel];
  if (!a) throw new Error(`No device adapter for ${channel}`);
  const r = a.collect(Math.min(200, Math.max(1, Math.floor(Number(max) || 40))));
  return { ...r, samples: r.samples.filter((x) => x.text.trim().length >= MIN_CHARS) };
}
