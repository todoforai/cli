# CLI Device Auth (`todoai login`)

## Current

```
todoai --set-default-api-key <key>   # manual copy-paste from web
todoai --api-key <key> "prompt"      # per-invocation
TODOFORAI_API_KEY=xxx todoai "prompt" # env var
```

No browser-based login. User must manually get API key from web UI.

## Solution

Add `todoai login` command using the same backend endpoints the edge already uses.

### Flow

```
$ todoai login
🔑 Open this URL to authorize:
https://todofor.ai/cli-auth?code=abc123...
Verification code: ABC123EF

Waiting for approval (expires in 10min)...
✅ Login successful! API key saved.
```

### Implementation: ~30 lines in `src/index.ts`

The CLI already imports `ApiClient` from `@todoforai/edge/src/api` which has
`initDeviceLogin()` and `pollDeviceLogin()`.

**Key resolution priority** (same as edge):
```
1. --api-key flag
2. config store (default_api_key)
3. TODOFORAI_API_KEY env
4. → trigger device login if interactive
```

#### Changes

**`src/args.ts`** — add `login` to usage + positional command detection (~3 lines)

**`src/index.ts`** — add login handler before API key check (~25 lines):

```typescript
// Handle `todoai login`
if (positionals[0] === "login") {
  const apiUrl = normalizeApiUrl(
    (args["api-url"] as string) || cfg.data.default_api_url || getEnv("API_URL") || DEFAULT_API_URL,
  );
  const api = new ApiClient(apiUrl, ""); // no key needed for init
  const { code, url, expiresIn } = await api.initDeviceLogin("cli");

  const shortCode = code.slice(-8).toUpperCase();
  console.log(`\n🔑 Open this URL to authorize:`);
  console.log(`\x1b[36m${url}\x1b[0m`);
  console.log(`Verification code: \x1b[1m${shortCode}\x1b[0m\n`);

  // Best-effort open browser
  try {
    const { exec } = require("child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} "${url}"`);
  } catch {}

  console.log(`Waiting for approval (expires in ${Math.round(expiresIn / 60)}min)...`);
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const poll = await api.pollDeviceLogin(code);
      if (poll.status === "complete" && poll.apiKey) {
        cfg.setDefaultApiKey(poll.apiKey);
        console.log("\x1b[32m✅ Login successful! API key saved.\x1b[0m");
        return;
      }
      if (poll.status === "expired") break;
    } catch {} // transient error — keep polling
  }
  console.error("\x1b[31mLogin expired or failed.\x1b[0m");
  process.exit(1);
}
```

#### Optional: auto-login when no key

In the existing `if (!apiKey)` block, instead of just erroring, offer device login
if stdin is a TTY — same pattern as edge's step 3→4 fallback.

### Not changed

- `--api-key` / env var still work as before
- `--set-default-api-key` still works for manual key setting
- Config store format unchanged (key saved in `default_api_key`)
- Backend: no changes needed

### Comparison

| | Current | With `todoai login` |
|---|---|---|
| First use | copy-paste key from web | `todoai login` → approve → done |
| Key storage | `--set-default-api-key` | automatic after login |
| CI/headless | `--api-key` / env | same |
