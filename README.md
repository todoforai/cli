# todoforai-cli CLI

CLI for [TODOforAI](https://todofor.ai) — create, watch, and inspect AI-powered todos.

## Install

```bash
bun install -g @todoforai/cli
# Install the native bridge once, if it is not already on PATH:
curl -fsSL https://raw.githubusercontent.com/todoforai/bridge/main/install.sh | sh
```

## Setup

Just run `todoforai-cli` — on first use it opens a browser for **device login** and saves the CLI API key in the shared TODOforAI credentials file. The bridge uses the same file for its own device credentials.

```bash
todoforai-cli                # prompts device login if no key found
todoforai-cli login          # explicit login
```

API URL resolution: `--api-url` flag → `TODOFORAI_API_URL` env → `https://api.todofor.ai`.

Auth resolution: `--api-key` flag → `TODOFORAI_API_KEY` env → shared credentials file → device login.

Project, agent, and last-todo state are stored **per API URL** under `per_api_url[<url>]` in the config — switching between e.g. `https://api.todofor.ai` and `http://localhost:4000` keeps each environment's defaults isolated. Legacy top-level fields are auto-migrated on first run.

## Bridge

The CLI talks to the backend over WebSocket; **shell execution, file I/O, and tool calls happen in the bridge** running locally. On create/resume/template runs, `todoforai-cli` starts a detached `todoforai-bridge` process if needed (the bridge enforces its own single-instance lock, logs at `~/.todoforai/bridge.log`). If bridge credentials are missing, the CLI runs `todoforai-bridge login` in the foreground first so you can see and approve the device-login URL. The bridge keeps running after the CLI exits, so long-running tasks survive `Ctrl+D`.

Disable with `--no-bridge` if you manage the bridge yourself (e.g. systemd, separate terminal). `--no-edge` remains supported as a deprecated alias.

## Usage

### Create a todo from a prompt

```bash
todoforai-cli "Fix the login bug"
todoforai-cli -n "Quick task"                    # non-interactive (run and exit)
echo "content" | todoforai-cli                   # pipe from stdin
todoforai-cli --path /my/project "Fix bug"       # explicit workspace
```

### Start from a registry template

```bash
todoforai-cli --template alternativeto-listing                          # interactive input prompts
todoforai-cli --template f5bot-monitoring-setup --input "monitoring_details=My Brand"  # with inputs
todoforai-cli --template f5bot-monitoring-setup --no-watch --json       # create only
```

When inputs are missing, the CLI prompts interactively (unless `-n`).

### Inspect a todo (read-only)

```bash
todoforai-cli --inspect <todo-id>
```

Prints the full chat log: messages, tool calls (type, status, path/cmd), results, and errors. No logo, no interactive mode.

### Resume / continue

```bash
todoforai-cli -c                     # continue most recent todo
todoforai-cli --resume <todo-id>     # resume specific todo
```

## IDE integration (ACP)

`todoforai-cli acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio, so any ACP-capable editor can drive your agent: prompts from the editor chat, file edits as native diffs, permission prompts inline, and shell commands running on your machine through the bridge. One ACP thread = one todo. Requires `todoforai-cli login` first; `--isolated` / `--user-id` are not supported in this mode.

**Zed** — `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "TODOforAI": { "type": "custom", "command": "todoforai-cli", "args": ["acp"] }
  }
}
```

Then open the Agent panel → `+` → **TODOforAI**.

**JetBrains (IntelliJ, PyCharm, WebStorm… 2025.2+)** — AI Chat → `⋮` → **Add Custom Agent**, which opens `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "TODOforAI": { "command": "todoforai-cli", "args": ["acp"] }
  }
}
```

Pick **TODOforAI** from the agent dropdown in AI Chat.

**VS Code** — no built-in ACP client yet; install a community ACP client extension (e.g. [`strato-space.acp-plugin`](https://marketplace.visualstudio.com/items?itemName=strato-space.acp-plugin)) and add the same `agent_servers` entry to `settings.json`.

`--agent`, `--project` and `--api-url` apply to `acp` as well (e.g. `"args": ["acp", "--agent", "backend"]`). If `todoforai-cli` is not on the editor's `PATH`, use its absolute path (`which todoforai-cli`).

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
