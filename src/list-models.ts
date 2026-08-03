/** `--list-models` handler — prints the model ids usable with `--model`.
 *
 * Source: `GET /api/v1/models` (the OpenAI-compatible LLM-proxy listing).
 * Agent settings take `provider:openrouter-id` (e.g. `anthropic:anthropic/claude-opus-5`),
 * so ids are printed in that form — copy-paste straight into `--model`.
 */

import type { ApiClient } from "@todoforai/edge/src/api";
import { BRAND, RESET } from "./colors";

export async function listModelsCommand(
  api: ApiClient,
  opts: { json?: boolean; filter?: string },
) {
  const res: any = await api.listModels();
  const q = opts.filter?.toLowerCase();
  const ids: string[] = (res?.data || [])
    .map((m: any) => `${String(m.id).split("/")[0]}:${m.id}`)
    .filter((id: string) => !q || id.toLowerCase().includes(q));

  if (opts.json) { console.log(JSON.stringify(ids, null, 2)); return; }
  for (const id of ids) process.stderr.write(`${BRAND}${id}${RESET}\n`);
}
