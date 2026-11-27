/** `audit` — the project's company audit log, raw: every event as one JSON line. */

import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ApiClient } from "@shared/api";
import { GREEN, RED, RESET } from "./colors";

export function printAuditHelp() {
  process.stderr.write(`
tfa-cli audit — the project's audit log, raw (JSONL: one event per line, oldest first)

Usage:
  tfa-cli audit export [--since <when>] [--until <when>] [--todo <id>] [--user <userId>]
                       [--agent <agentSettingsId>] [--type tool|permission|history|exec|export]
                       [--project <id>] [-o file.jsonl]
  tfa-cli audit schema                 What each line holds (give it to any AI with the file)

<when>: epoch ms or an ISO date/time (2026-11-01, 2026-11-01T09:00Z).
You get exactly what your rights show now: your own actions, the todos you can see; project
managers get the whole team except other people's private todos. Every export is itself logged.
Examples:
  tfa-cli audit export --since 2026-11-01 -o nov.jsonl
  tfa-cli audit export --todo <id> | jq -c 'select(.type=="tool") | [.at, .block.type, .block.status, .block.approval.by]'
`);
}

const SCHEMA = `Audit log, schema v1 — one JSON object per line, oldest first.
Every line: v (1), at (epoch ms), type, projectId, userId (who did it; tool calls: the user the
agent ran for), todoId?, groupTag? (the todo's group then, "" = none), messageId?, agentSettingsId?.
A todo's chat: https://todofor.ai/t/<todoId>.

type "tool"        An agent tool call reached its final status. block = the whole call:
                   type (bash, edit, …), params (cmd, path, …), deviceId, status (COMPLETED |
                   ERROR | DENIED), results / result (output), fileChanges (diffs), runMeta,
                   approval {by, at, result allow|deny, remember, deviceId?} when a person decided.
                   A call is written again when it later gains its diff or its background
                   task exits: the last line per block.id is its final state.
type "permission"  An approval saved as an agent rule: rule allow|deny, patterns[], blockId.
type "history"     A versioned change (workflow edit/restore, access change): target {kind, id},
                   entry {rev, by, kind edit|acl|restore, snapshot}.
type "exec"        A command run on a machine outside a chat tool call (a Show's todo.exec, a
                   workflow shell box, a direct device run): deviceId, cmd, cwd?, exitCode,
                   timedOut?, stdout, error? (the bridge failed after sending it: it may
                   or may not have run).
type "export"      Someone exported the log: filter (logged before the export's lines).

Known credential shapes (API keys, tokens, auth headers, credential URL params) and
secret-named fields are redacted when written ([REDACTED]); other secrets printed in
output are not recognized. Strings over 200k chars are cut
(…[truncated N chars]), the full text stays in the chat.
`;

export const printAuditSchema = () => process.stdout.write(SCHEMA);

export async function auditExportCommand(api: ApiClient, args: Record<string, any>, projectId?: string) {
  if (!projectId) { process.stderr.write(`${RED}No project: pass --project <id>${RESET}\n`); process.exit(2); }
  const body = await api.auditExport(projectId, {
    since: args.since, until: args.until, todo: args.todo, user: args.user, agent: args.agent, type: args.type,
  });
  const out = args.output ? createWriteStream(args.output) : process.stdout;
  await pipeline(Readable.fromWeb(body as any), out);
  if (args.output) process.stderr.write(`${GREEN}✅ Audit log written to ${args.output}${RESET}\n`);
}
