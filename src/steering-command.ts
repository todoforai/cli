// `todoforai-cli steering ...` and `todoforai-cli next` — steer the recommendation
// generator (persisted per project) and trigger a generation run.
//
// Self-contained: talks to the REST endpoints directly so it doesn't depend on the
// edge ApiClient. Auth mirrors the rest of the CLI (x-api-key header).

const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";

interface Ctx {
  apiUrl: string;   // base, e.g. https://api.todofor.ai
  apiKey: string;
  projectId: string;
  json: boolean;
}

async function rest(ctx: Ctx, method: string, path: string, body?: unknown) {
  const res = await fetch(`${ctx.apiUrl}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": ctx.apiKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function printSteering(s: any) {
  process.stderr.write(`${GREEN}Direction:${RESET} ${s.direction || DIM + "(none)" + RESET}\n`);
  process.stderr.write(`${GREEN}Boosted:${RESET}   ${s.boostedCategoryIds?.join(", ") || DIM + "(none)" + RESET}\n`);
  process.stderr.write(`${GREEN}Muted:${RESET}     ${s.mutedCategoryIds?.join(", ") || DIM + "(none)" + RESET}\n`);
}

const USAGE = `${RED}Usage:
  todoforai-cli steering get [--project <id>]
  todoforai-cli steering direction "<text>" [--project <id>]   (empty text clears it)
  todoforai-cli steering boost <categoryId> [--project <id>]
  todoforai-cli steering mute  <categoryId> [--project <id>]
  todoforai-cli steering clear [--project <id>]                (clears all steering)${RESET}`;

/** Handle `steering <sub> [args]`. `argv` is everything after `steering`. */
export async function steeringCommand(ctx: Ctx, argv: string[]): Promise<void> {
  const sub = argv[0];
  const path = `/projects/${ctx.projectId}/recommendation-steering`;

  if (!sub || sub === "get") {
    const s = await rest(ctx, "GET", path);
    if (ctx.json) console.log(JSON.stringify(s, null, 2));
    else printSteering(s);
    return;
  }

  if (sub === "direction") {
    const text = argv.slice(1).join(" ").trim();
    const s = await rest(ctx, "PATCH", path, { projectId: ctx.projectId, direction: text || null });
    if (ctx.json) console.log(JSON.stringify(s, null, 2));
    else process.stderr.write(`${GREEN}✅ ${text ? `Direction set: ${text}` : "Direction cleared"}${RESET}\n`);
    return;
  }

  if (sub === "boost" || sub === "mute") {
    const categoryId = argv[1];
    if (!categoryId) { process.stderr.write(USAGE + "\n"); process.exit(2); }
    // Read-modify-write: adding a category to one list removes it from the other.
    const current = await rest(ctx, "GET", path);
    const key = sub === "boost" ? "boostedCategoryIds" : "mutedCategoryIds";
    const other = sub === "boost" ? "mutedCategoryIds" : "boostedCategoryIds";
    const next = Array.from(new Set([...(current[key] ?? []), categoryId]));
    const nextOther = (current[other] ?? []).filter((c: string) => c !== categoryId);
    const s = await rest(ctx, "PATCH", path, { projectId: ctx.projectId, [key]: next, [other]: nextOther });
    if (ctx.json) console.log(JSON.stringify(s, null, 2));
    else process.stderr.write(`${GREEN}✅ ${sub === "boost" ? "Boosted" : "Muted"} ${categoryId}${RESET}\n`);
    return;
  }

  if (sub === "clear") {
    const s = await rest(ctx, "PATCH", path, { projectId: ctx.projectId, direction: null, boostedCategoryIds: [], mutedCategoryIds: [] });
    if (ctx.json) console.log(JSON.stringify(s, null, 2));
    else process.stderr.write(`${GREEN}✅ Steering cleared${RESET}\n`);
    return;
  }

  process.stderr.write(USAGE + "\n");
  process.exit(2);
}
