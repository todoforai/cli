/** `inbox` (read the notification feed) and `notify` (a note to your own user, or with --to to a project teammate). */

import { createHash } from "crypto";
import type { ApiClient } from "@shared/api";
import { senderLabel, type FeedEvent, type FeedPage, type FeedTier } from "@shared/fbe";
import { readStdin } from "./input";
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "./colors";

/** CLI names = the bell's tab labels. */
const TIERS: Record<string, FeedTier> = { "needs-you": "priority", priority: "priority", activity: "activity", messages: "user_messages" };

export function printInboxHelp() {
  process.stderr.write(`
tfa-cli inbox — the user's notification feed (the bell)

Usage:
  tfa-cli inbox [needs-you|messages|activity] [--unread] [--limit 20] [--json]
  tfa-cli inbox seen [needs-you|messages|activity]    Mark read (omit = everything)

Filters (same as the bell's chips):
  needs-you  invites, offers, a todo waiting on the user, a failed todo   (alias: priority)
  messages   notes from the TODO for AI team or from an agent
  activity   finished / recommended todos
`);
}

export function printNotifyHelp() {
  process.stderr.write(`
tfa-cli notify — leave a note in someone's Messages inbox (+ phone push)

Usage:
  tfa-cli notify "Title" "message" [--href /t/<todo-id>] [--subject <key>] [--json]
  tfa-cli notify --to <email> "Title" "message" [--project <id>]
  echo "message" | tfa-cli notify "Title"

Recipient: your own user by default. --to <email> reaches a TEAMMATE: someone who is a member
of the current project (--project, $TODOFORAI_PROJECT_ID or your default), shown as from you.
Anyone else is refused. List them with: tfa-cli project members
--subject dedupes: the same subject is delivered once (default: hash of title+message,
so a retry never double-notifies). --href must be an in-app path.
Limits: 10 notes/day to yourself, 20/day to teammates.
`);
}

function tierArg(name: string | undefined): FeedTier | undefined {
  if (!name) return undefined;
  const tier = TIERS[name];
  if (!tier) { process.stderr.write(`${RED}Unknown tab "${name}" — use needs-you, messages, activity${RESET}\n`); process.exit(2); }
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
  if (counts) process.stderr.write(`${DIM}unread — needs you ${counts.priority} · messages ${counts.user_messages} · activity ${counts.activity}${RESET}\n`);
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

/** Recipient spellings other than --to: unknown flags fall through to positionals, which would
 *  silently deliver `--email anna@x.com "Hi"` to YOURSELF titled "anna@x.com". */
const OTHER_RECIPIENT_FLAGS = ["--email", "--user", "--recipient", "--cc"];

export async function notifyCommand(api: ApiClient, positionals: string[], args: Record<string, any>, projectId?: string) {
  const bad = process.argv.slice(2).find((a) => OTHER_RECIPIENT_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
  if (bad) {
    process.stderr.write(`${RED}Unknown option ${bad.split("=")[0]}: use --to <email> for a project teammate${RESET}\n`);
    process.exit(2);
  }
  const to = args.to === undefined ? undefined : String(args.to).trim();
  if (to === "") {
    process.stderr.write(`${RED}--to is empty: pass a teammate's email, or drop --to to notify your own user${RESET}\n`);
    process.exit(2);
  }
  if (to && !projectId) {
    process.stderr.write(`${RED}--to needs a project: pass --project <id> (the recipient must be a member of it)${RESET}\n`);
    process.exit(2);
  }
  const [, title, ...rest] = positionals;
  const message = rest.join(" ") || (process.stdin.isTTY ? "" : (await readStdin()).trim());
  if (!title || !message) { printNotifyHelp(); process.exit(2); }
  const subject = (args.subject as string) || createHash("sha256").update(`${title}\n${message}`).digest("hex").slice(0, 16);
  const msg = { subject, title, message, ...(args.href ? { href: String(args.href) } : {}) };
  const row = await (to ? api.sendMemberMessage({ ...msg, projectId: projectId!, to }) : api.sendFeedMessage(msg)) as FeedEvent & { created: boolean };
  if (args.json) { console.log(JSON.stringify(row)); return; }
  process.stderr.write(row.created !== false
    ? `${GREEN}✅ Delivered to ${to ?? "your own user"}'s Messages inbox${RESET} ${DIM}(subject ${subject})${RESET}\n`
    : `${DIM}Already sent (subject ${subject}) — nothing new delivered${RESET}\n`);
}
