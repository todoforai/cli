/** CLI argument parsing and usage */

import { parseArgs } from "util";
import pkg from "../package.json" with { type: "json" };
import { TodoStatus } from "@shared/fbe";

export const DEFAULT_API_URL = "https://api.todofor.ai";
export const VERSION: string = pkg.version;

export function getEnv(name: string): string {
  return (process.env[`TODOFORAI_${name}`] || process.env[`TODO4AI_${name}`] || "").trim();
}

export function printUsage() {
  process.stderr.write(`
tfa-cli — TODOforAI CLI

Usage: tfa-cli [OPTIONS] ["prompt"]
       tfa-cli [OPTIONS] <COMMAND> [ARGS]

Examples:
  tfa-cli login                          # Browser-based device auth
  tfa-cli "prompt text"                  # New todo
  echo "content" | tfa-cli              # From stdin
  tfa-cli start <id>                    # Registry template
  tfa-cli acp                           # Agent Client Protocol (stdio)
  tfa-cli agents                        # List agents
  tfa-cli models [filter]               # Available models
  tfa-cli agent update <agent> model=<model>    # Update agent settings (see 'agent --help'; also 'agent create')
  tfa-cli todo set <todo-id|-> title=… group=… star=true   # Edit a todo's fields (see 'todo --help')
  tfa-cli project list|set|settings|groups|default|agent … # Projects; edit the current one (see 'project --help')
  tfa-cli brand list|create|select|voice …      # Brands (business contexts) + voice learning (see 'brand --help')
  tfa-cli device list|rename|wallpaper …        # Paired machines (see 'device --help')
  tfa-cli list [-n 30] [--cursor N] [--all] [--status S]  # List todos (paginated); see 'list --help'
  tfa-cli status <todo-id> <STATUS>     # Update a todo's status (run 'status --help' for the full list)
  tfa-cli delete <todo-id>              # Permanently delete a todo
  tfa-cli addmessage <todo-id> "text"  # Send a message and exit (like -r, no watch/bridge)
  tfa-cli show <file|-> [todo-id]     # Show a file in the chat (rendered by mimetype; - reads stdin)
                                            #   [--title T] [--alias A] [--mime M] [--card <name>] [--link] [--json]
                                            #   --link: download chip. Output: "<todoId>:<alias|id>  <public url>".
                                            #   Same --alias updates in place; old versions: /<id>/<version>.
  tfa-cli show rm <ref|alias>         # Take a shown file down (block, url, every version)
  tfa-cli show list [todo-id]         # List show blocks (ref, title, mime/url, card)
                                            #   [--project <id>] [--card <name>] [--json]
                                            #   no todo-id + --project (or $TODOFORAI_PROJECT_ID) = every todo
  tfa-cli open <url> [todo-id]        # Show a live http(s) url in the chat as a preview
                                            #   [--title T] [--alias A] [--json]
  tfa-cli recommend --template <id>    # Add a template as a recommendation card (see 'todoregistry-cli create')
  tfa-cli claim mint --seed <projectId> [--emails a@x,b@y] [--ttl <sec>]  # Mint /claim/<token> ownership links for a project you own
  tfa-cli next [--direction "<text>"]  # Ask the analyzer for growth recommendation cards (optional free-text steer)

Options:
  --path <dir>                    Workspace path (default: cwd)
  --project <id>                  Project ID
  --agent, -a <name>              Agent name (partial match)
  --group <slug>                 Group new todo; omitted inherits TODOFORAI_GROUP_ID
  --group-name <name>            Display name for --group (last write wins)
  --model <model>                 Model for this todo only (see 'models')
  --api-url <url>
  --api-key <key>
  --user-id <id>                  Admin HTTP impersonation; requires --no-watch
  --inspect, -i <todo-id>[@<slice>]  Read chat log; slices: -3:, :1, 5:10, 7
  --template, -t <id> ["prompt"]   Same as start; prompt overrides template task
  --resume, -r <todo-id> ["prompt"]  Resume; optional follow-up
  --continue, -c ["prompt"]       Resume last; optional follow-up
  --non-interactive, -n           Run to completion, then exit
  --dangerously-skip-permissions  Auto-approve all blocks (for CI/benchmarks)
  --allow-all                     Set permissions to allow all tools (no approval needed)
  --raw-sysmsg <file>             Use file contents verbatim as system prompt (new TODO only)
  --no-watch                      Create todo and exit
  --isolated                      Agent sees ONLY this machine + dir (no cloud VM/other devices); ends with CLI
  --no-bridge                     Do not auto-spawn bridge
  --json
  --detailed                      'inspect --json': keep ids, timestamps, agentSettingsId, scheduledTimestamp
  --format-anthropic              'inspect --json': Anthropic-style shape (tool_result in next user msg); attachment sources are uri-typed, so not a 1:1 messages.create input
  --safe                          Validate API key upfront
  --debug, -d
  --debug-dump                    Attach LLM request debug info per turn (requires server grant)
  help | version | config         = -h | -v | --show-config   (--reset-config wipes it)
`);
}

/** Statuses a user typically sets manually (the rest are driven by the agent/UI). */
const STATUS_HELP: Partial<Record<TodoStatus, string>> = {
  [TodoStatus.READY]: "AI finished the work on the TODO",
  [TodoStatus.READY_CHECKED]: "AI finished and the user reviewed it",
  [TodoStatus.DONE]: "Completed and finalized",
  [TodoStatus.REVIEW_REQUESTED]: "Asks the user to review",
  [TodoStatus.POSTPONED]: "Put off for later",
  [TodoStatus.ARCHIVED]: "Archived (hidden from active list)",
  [TodoStatus.DELETED]: "Marked for deletion",
};

export function printStatusHelp() {
  process.stderr.write(`
tfa-cli status <todo-id> <STATUS>

Common statuses:
${Object.entries(STATUS_HELP).map(([s, d]) => `  ${s.padEnd(18)}${d}`).join("\n")}

All valid statuses:
  ${Object.values(TodoStatus).join(", ")}
`);
}

// Bare words that unambiguously mean an existing flag: `tfa-cli help` == `--help`.
// Accepting them is friendlier than erroring on something that already exists.
const WORD_FLAGS: Record<string, string> = {
  help: "help",
  version: "version",
  models: "list-models",
  agents: "list-agents",
  config: "show-config",
};
// Subcommands that print their own help; anywhere else a second positional is data.
const HELP_SUBCOMMANDS = ["agent", "todo", "project", "brand", "device", "list", "ls", "status"];

export function parseCliArgs() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      path: { type: "string", default: "." },
      project: { type: "string" },
      agent: { type: "string", short: "a" },
      model: { type: "string" },
      group: { type: "string" },
      "group-name": { type: "string" },
      "group-description": { type: "string" },
      "list-agents": { type: "boolean", default: false },
      "list-models": { type: "boolean", default: false },
      "api-url": { type: "string" },
      "api-key": { type: "string" },
      "user-id": { type: "string" },
      inspect: { type: "string", short: "i" },
      template: { type: "string", short: "t" },
      note: { type: "string" },
      priority: { type: "string" },
      title: { type: "string" },
      alias: { type: "string" },
      mime: { type: "string" },
      card: { type: "string" },
      link: { type: "boolean", default: false },
      direction: { type: "string" },
      "business-context": { type: "string" },
      brand: { type: "string" },
      url: { type: "string" },
      "pasted-file": { type: "string" },
      "from-company": { type: "boolean", default: false },
      seed: { type: "string" },
      emails: { type: "string" },
      ttl: { type: "string" },
      resume: { type: "string", short: "r" },
      continue: { type: "boolean", short: "c", default: false },
      "non-interactive": { type: "boolean", short: "n", default: false },
      "dangerously-skip-permissions": { type: "boolean", default: false },
      "allow-all": { type: "boolean", default: false },
      "raw-sysmsg": { type: "string" },
      "no-watch": { type: "boolean", default: false },
      isolated: { type: "boolean", default: false },
      "debug-dump": { type: "boolean", default: false },
      "no-bridge": { type: "boolean", default: false },
      "no-edge": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      detailed: { type: "boolean", default: false },
      "format-anthropic": { type: "boolean", default: false },
      safe: { type: "boolean", default: false },
      debug: { type: "boolean", short: "d", default: false },
      "show-config": { type: "boolean", default: false },
      "reset-config": { type: "boolean", default: false },
      "config-path": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  if (values["no-edge"]) values["no-bridge"] = true;
  // `tfa-cli help` / `tfa-cli models [filter]` → the flag they obviously mean.
  // Skipped when that mode flag is already set (`--list-models models`), where the
  // word is the flag's operand, not a command.
  const asFlag = !values["list-models"] && !values["list-agents"] && !values["show-config"]
    ? WORD_FLAGS[positionals[0]] : undefined;
  if (asFlag) { values[asFlag] = true; positionals.shift(); }
  // `tfa-cli project help` → `project --help`. Elsewhere (`show help`, `next help`)
  // that slot is data, never a help request.
  if (positionals[1] === "help" && HELP_SUBCOMMANDS.includes(positionals[0])) { values.help = true; positionals.splice(1, 1); }
  return { values, positionals };
}
