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
tfa-cli — TODOforAI CLI. Legacy aliases: todoforai-cli, todoai.

Usage:
  tfa-cli login                          # Browser-based device auth
  tfa-cli "prompt text"                  # Prompt as argument
  tfa-cli -n "Quick task"               # Non-interactive (run and exit)
  echo "content" | tfa-cli              # Pipe from stdin
  tfa-cli --path /my/project "Fix bug"  # Explicit workspace path
  tfa-cli -c ["prompt"]                 # Resume last todo (optional prompt sent on attach)
  tfa-cli --resume <todo-id> ["prompt"] # Resume specific todo (optional prompt sent on attach)
  tfa-cli --inspect <todo-id>[@<slice>] # Read chat log. <slice> = -3:, :1, 5:10, 7  (Python-style)
  tfa-cli start <id>                    # Start a TODO from the registry (todoregistry.com)
  tfa-cli acp                           # Agent Client Protocol server on stdio (Zed, JetBrains, …; see README)
  tfa-cli agents                        # List available agents and exit
  tfa-cli models [filter]               # List models usable with --model and exit
  tfa-cli agent update <agent> model=<model>    # Update agent settings (see 'agent --help'; also 'agent create')
  tfa-cli todo set <todo-id|-> title=… group=… star=true   # Edit a todo's fields (see 'todo --help')
  tfa-cli project list|set|settings|groups|default|agent … # Projects; edit the current one (see 'project --help')
  tfa-cli brand list|create|select|voice …      # Brands (business contexts) + voice learning (see 'brand --help')
  tfa-cli device list|rename|wallpaper …        # Paired machines (see 'device --help')
  tfa-cli list [-n 30] [--cursor N] [--all] [--status S]  # List todos (paginated); see 'list --help'
  tfa-cli status <todo-id> <STATUS>     # Update a todo's status (run 'status --help' for the full list)
  tfa-cli delete <todo-id>              # Permanently delete a todo
  tfa-cli addmessage <todo-id> "text"  # Add a message to an existing todo
  tfa-cli show <file|-> [todo-id]     # Show a file in the chat (rendered by mimetype; - reads stdin)
                                            #   [--title T] [--alias A] [--mime M] [--card <name>] [--link] [--json]
                                            #   --link = compact chip (name+size+download) instead of inline render
                                            #   Prints "<todoId>:<alias|id>  <public url>". Re-showing with the same
                                            #   --alias updates that block in place and pushes a new version to the
                                            #   same url (older versions stay reachable at /<id>/<version>).
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
  --model <model>                 Override the agent's model for this todo
                                  (e.g. anthropic:anthropic/claude-opus-5, openai:openai/gpt-5.6-sol)

  --api-url <url>                 API URL
  --api-key <key>                 API key
  --user-id <id>                  Admin HTTP impersonation; requires --no-watch
  --inspect, -i <todo-id>[@<slice>]     Print chat log (read-only)
  --template, -t <id> ["prompt"] Start from a registry template (alias: start <id>); prompt overrides the template task
  --resume, -r [todo-id]          Resume existing todo
  --continue, -c                  Continue most recent todo
  --non-interactive, -n           Run to completion and exit without interactive prompt
  --dangerously-skip-permissions  Auto-approve all blocks (for CI/benchmarks)
  --allow-all                     Set permissions to allow all tools (no approval needed)
  --raw-sysmsg <file>             Use file contents verbatim as system prompt (new TODO only)
  --no-watch                      Create todo and exit
  --isolated                      Spawn an ephemeral, task-scoped bridge: the agent sees ONLY
                                  this machine (workspace = --path/cwd); session dies with the CLI
  --no-bridge                     Do not auto-spawn bridge
  --no-edge                       Deprecated alias for --no-bridge
  --json                          Output as JSON
  --detailed                      'inspect --json': keep ids, timestamps, agentSettingsId, scheduledTimestamp
  --format-anthropic              'inspect --json': Anthropic-style shape (tool_result in next user msg); attachment sources are uri-typed, so not a 1:1 messages.create input
  --safe                          Validate API key upfront
  --debug, -d                     Debug output
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
