# TODOforAI CLI (`tfa-cli`)

Create and manage [TODOforAI](https://todofor.ai) tasks from your terminal.

## Install and run

Requires Node.js 20+.

```bash
npm install -g @todoforai/cli
tfa-cli "Fix the login bug"
```

`todoforai-cli` is an alias for `tfa-cli`.

## Configuration

API URL resolution: `--api-url` flag → `TODOFORAI_API_URL` env → `https://api.todofor.ai`.

Auth resolution: `--api-key` flag → shared-device run token → shared credentials file → `TODOFORAI_API_TOKEN` env → device login.

Project, agent, and last-todo state are stored **per API URL** under `per_api_url[<url>]` in the config — switching between e.g. `https://api.todofor.ai` and `http://localhost:4000` keeps each environment's defaults isolated. Legacy top-level fields are auto-migrated on first run.

## Bridge

Installed automatically on Linux and macOS.

The CLI talks to the backend over WebSocket; **shell execution, file I/O, and tool calls happen in the bridge** running locally. On create/resume/template runs, `tfa-cli` starts a detached `todoforai-bridge` process if needed (the bridge enforces its own single-instance lock, logs at `~/.todoforai/bridge.log`). If bridge credentials are missing, the CLI runs `todoforai-bridge login` in the foreground first so you can see and approve the device-login URL. The bridge keeps running after the CLI exits, so long-running tasks survive `Ctrl+D`.

Disable with `--no-bridge` if you manage the bridge yourself (e.g. systemd, separate terminal). `--no-edge` remains supported as a deprecated alias.

## Usage

### Create a todo from a prompt

```bash
tfa-cli -n "Quick task"                    # non-interactive (run and exit)
echo "content" | tfa-cli                   # pipe from stdin
tfa-cli --path /my/project "Fix bug"       # explicit workspace
```

Ctrl+C (or closing the terminal) only exits the CLI — the todo keeps running; `tfa-cli --resume <id>` reattaches. Exception: `--isolated` runs are stopped, since they can't outlive their bridge.

### Start from a registry template

```bash
tfa-cli --template alternativeto-listing                          # interactive input prompts
tfa-cli --template f5bot-monitoring-setup --input "monitoring_details=My Brand"  # with inputs
tfa-cli --template f5bot-monitoring-setup --no-watch --json       # create only
```

When inputs are missing, the CLI prompts interactively (unless `-n`).

### Inspect a todo (read-only)

```bash
tfa-cli --inspect <todo-id>
```

Prints the full chat log: messages, tool calls (type, status, path/cmd), results, and errors. No logo, no interactive mode.

### Resume / continue

```bash
tfa-cli -c                     # continue most recent todo
tfa-cli --resume <todo-id>     # resume specific todo
```

### Notifications

```bash
tfa-cli inbox                           # the bell: newest across all tabs
tfa-cli inbox messages --unread         # one filter: needs-you | messages | activity
tfa-cli inbox seen                      # mark everything read
tfa-cli notify "Deploy done" "v2 is live" --href /t/<todo-id>   # note to YOUR user (Messages tab + phone push)
tfa-cli project members                                          # who can be notified
tfa-cli notify --to anna@x.com "Review?" "PR is ready" --href /t/<todo-id>   # note to ONE project member
```

`notify` goes to your own user by default. `--to <email>` reaches one member of the current project (`--project <id>`, `$TODOFORAI_PROJECT_ID` or the default project); non-members are refused (404). It is shown as from you (or your agent). There is no broadcast / "all members" flag, so loop over `project members` to reach the whole team. `--subject` sets the dedupe key (the same text is delivered once), `--href` must be an in-app path. Caps: 10 new notes/day to yourself, 20/day to teammates.

## IDE integration (ACP)

`tfa-cli acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio, so any ACP-capable editor can drive your agent: prompts from the editor chat, file edits as native diffs, permission prompts inline, and shell commands running on your machine through the bridge. One ACP thread = one todo. To log in explicitly, run `tfa-cli login`; `--isolated` / `--user-id` are not supported in this mode.

**Zed** — `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "TODOforAI": { "type": "custom", "command": "tfa-cli", "args": ["acp"] }
  }
}
```

Then open the Agent panel → `+` → **TODOforAI**.

**JetBrains (IntelliJ, PyCharm, WebStorm… 2025.2+)** — AI Chat → `⋮` → **Add Custom Agent**, which opens `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "TODOforAI": { "command": "tfa-cli", "args": ["acp"] }
  }
}
```

Pick **TODOforAI** from the agent dropdown in AI Chat.

**VS Code** — no built-in ACP client yet; install a community ACP client extension (e.g. [`strato-space.acp-plugin`](https://marketplace.visualstudio.com/items?itemName=strato-space.acp-plugin)) and add the same `agent_servers` entry to `settings.json`.

No global install needed — `"command": "npx", "args": ["-y", "@todoforai/cli", "acp"]` works in every host above. `--agent`, `--project` and `--api-url` apply to `acp` as well (e.g. `"args": ["acp", "--agent", "backend"]`). If `tfa-cli` is not on the editor's `PATH`, use its absolute path (`which tfa-cli`). Your agent settings show up in the host's mode picker, so you can switch agents per session without touching the config.

## All Options

```
--path <dir>                    Workspace path (default: cwd)
--project <id>                  Project ID
--agent, -a <name>              Agent name (partial match)
--api-url <url>                 API URL
--api-key <key>                 API key
--template, -t <id>             Start from a registry template
--input <key=value>             Template input (repeatable)
--inspect, -i <todo-id>         Print full chat log (read-only)
--resume, -r [todo-id]          Resume existing todo
--continue, -c                  Continue most recent todo
--non-interactive, -n           Run to completion and exit
--dangerously-skip-permissions  Auto-approve all blocks (CI/benchmarks)
--allow-all                     Set permissions to allow all tools (no approval needed)
--no-watch                      Create todo and exit
--no-bridge                     Do not auto-spawn bridge
--no-edge                       Deprecated alias for --no-bridge
--json                          Output as JSON
--safe                          Validate API key upfront
--debug, -d                     Debug output
--show-config                   Show config
--reset-config                  Reset config file
--help, -h                      Show this help
```
