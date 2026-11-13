/** Find a board item (note, widget) by id or loose title: case, accents, a substring, a dictation typo. */

import { RED, RESET } from "./colors";

export const fail = (msg: string): never => { process.stderr.write(`${RED}${msg}${RESET}\n`); process.exit(2); };

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function distance(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Lower is better; undefined = no match. Exact id/title, then substring, then typo distance (≤ 1/3 of the length). */
export function matchScore(id: string, title: string, query: string): number | undefined {
  if (id === query) return 0;
  const t = norm(title), q = norm(query);
  if (!t || !q) return undefined;
  if (t === q) return 0;
  if (t.includes(q)) return 1;
  // Within a typo per 3 chars: the whole title ("vibe hack" ≈ "vide hack"), or every query word ≈ a title word ("live widgte" ≈ "Live widget teszt").
  const near = (a: string, b: string) => { const d = distance(a, b); return d <= Math.max(a.length, b.length) / 3 ? d : Infinity; };
  const words = t.split(" ");
  const d = Math.min(near(t, q), q.split(" ").reduce((sum, w) => sum + Math.min(...words.map((c) => near(c, w))), 0));
  return d === Infinity ? undefined : 1 + d;
}

/** The one item `query` names (id or loose title); fails listing the candidates. exact = id or exact title only. */
export function findByTitle<T extends { id: string }>(items: T[], query: string, titleOf: (x: T) => string, exact = false, what = "note"): T {
  const ranked = items.map((n) => ({ n, s: matchScore(n.id, titleOf(n), query) })).filter((x) => x.s === 0 || (!exact && x.s !== undefined)).sort((a, b) => a.s! - b.s!);
  const list = (xs: T[]) => xs.map((n) => `  ${n.id}  ${titleOf(n)}`).join("\n");
  if (!ranked.length) return fail(`No ${what} ${exact ? "has the id or title" : "matches"} "${query}". ${what[0].toUpperCase() + what.slice(1)}s:\n${list(items)}`);
  const best = ranked.filter((x) => x.s === ranked[0].s);
  if (best.length > 1) return fail(`${best.length} ${what}s match "${query}": use the id\n${list(best.map((x) => x.n))}`);
  return ranked[0].n;
}
