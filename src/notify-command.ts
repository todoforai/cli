/** `inbox` (read the notification feed) and `notify` (agent → its own user's Messages tab). */

import { createHash } from "crypto";
import type { ApiClient } from "@shared/api";
import { senderLabel, type FeedEvent, type FeedPage, type FeedTier } from "@shared/fbe";
import { readStdin } from "./input";
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "./colors";

/** CLI names = the bell's tab labels. */
const TIERS: Record<string, FeedTier> = { priority: "priority", activity: "activity", messages: "user_messages" };

export function printInboxHelp() {
  process.stderr.write(`
tfa-cli inbox — the user's notification feed (the bell)

Usage:
  tfa-cli inbox [messages|priority|activity] [--unread] [--limit 20] [--json]
  tfa-cli inbox seen [messages|priority|activity]     Mark read (omit tab = everything)

Tabs: priority = invites, offers · activity = todo finished/failed/needs you · messages = notes from the team or an agent
`);
}

export function printNotifyHelp() {
  process.stderr.write(`
tfa-cli notify — leave a note for YOUR user (their Messages tab + phone push)

Usage:
  tfa-cli notify "Title" "message" [--href /t/<todo-id>] [--subject <key>] [--json]
  echo "message" | tfa-cli notify "Title"

Only reaches the user you run for — never someone else. Shown as from your agent.
--subject dedupes: the same subject is delivered once (default: hash of title+message,
so a retry never double-notifies). --href must be an in-app path. Max 10 new notes/day.
`);
}

function tierArg(name: string | undefined): FeedTier | undefined {
  if (!name) return undefined;
  const tier = TIERS[name];
  if (!tier) { process.stderr.write(`${RED}Unknown tab "${name}" — use ${Object.keys(TIERS).join(", ")}${RESET}\n`); process.exit(2); }
  return tier;
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

export async function inboxCommand(api: ApiClient, positionals: string[], args: Record<string, any>) {
  const [, first, second] = positionals;
  if (first === "seen") {
    const tier = tierArg(second);
    await api.markFeedSeen(tier ? { tier } : {});
    process.stderr.write(`${GREEN}✅ Marked ${second ?? "everything"} read${RESET}\n`);
    return;
  }
  const tier = tierArg(first);
  const limit = args.limit ? Number(args.limit) : 20;
  const page = await api.listFeed({ tier, limit, sinceSeen: !!args.unread || undefined }) as FeedPage;
  if (args.json) { console.log(JSON.stringify(page)); return; }
  const counts = page.unseenByTier;
  if (counts) process.stderr.write(`${DIM}unread — priority ${counts.priority} · activity ${counts.activity} · messages ${counts.user_messages}${RESET}\n`);
  if (!page.items.length) { process.stderr.write(`${DIM}Nothing here${RESET}\n`); return; }
  for (const e of page.items) {
    const from = e.sender ? `${CYAN}${senderLabel(e.sender)}${RESET} ` : "";
    const dot = e.unread ? `${YELLOW}●${RESET}` : " ";
    const state = e.resolution ? ` ${DIM}[${e.resolution}]${RESET}` : "";
    console.log(`${dot} ${DIM}${when(e.createdAt)}${RESET} ${from}${BOLD}${e.title ?? e.message}${RESET}${state}`);
    if (e.title && e.message) console.log(`    ${e.message.replace(/\n/g, "\n    ")}`);
    if (e.href) console.log(`    ${DIM}${e.href}${RESET}`);
  }
}

export async function notifyCommand(api: ApiClient, positionals: string[], args: Record<string, any>) {
  const [, title, ...rest] = positionals;
  const message = rest.join(" ") || (process.stdin.isTTY ? "" : (await readStdin()).trim());
  if (!title || !message) { printNotifyHelp(); process.exit(2); }
  const subject = (args.subject as string) || createHash("sha256").update(`${title}\n${message}`).digest("hex").slice(0, 16);
  const row = await api.sendFeedMessage({ subject, title, message, ...(args.href ? { href: String(args.href) } : {}) }) as FeedEvent & { created: boolean };
  if (args.json) { console.log(JSON.stringify(row)); return; }
  process.stderr.write(row.created !== false
    ? `${GREEN}✅ Sent to your Messages inbox${RESET} ${DIM}(subject ${subject})${RESET}\n`
    : `${DIM}Already sent (subject ${subject}) — nothing new delivered${RESET}\n`);
}
