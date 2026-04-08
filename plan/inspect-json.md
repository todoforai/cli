# `--inspect --json`

## Problem

`todoai --inspect <id>` currently only outputs human-readable colored text to stderr/stdout.
The test runner (`todo-registry/scripts/test-todo.ts`) has to read the CLI config file and hit the API directly to get structured data.

## Solution

When `--inspect` is combined with `--json`, output the full todo object as JSON to stdout.
No colors, no formatting — just the raw API response.

```bash
todoai --inspect <todo-id> --json
```

```json
{
  "id": "...",
  "status": "DONE",
  "messages": [
    { "role": "user", "content": "...", "blocks": [] },
    { "role": "assistant", "content": "...", "blocks": [
      { "type": "shell", "status": "COMPLETED", "cmd": "ls", "result": "..." }
    ]}
  ]
}
```

## Implementation

In `src/index.ts`, the inspect handler already calls `api.getTodo(todoId)`.
Just add: if `args.json`, `console.log(JSON.stringify(todo, null, 2))` instead of `printFullChat()`.

~5 lines of code.
