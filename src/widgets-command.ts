/** `widgets` — the project's board widgets: cards showing a ref (a show `<todoId>:<alias>`, a todo, a url), addressed by title. */

import { readFileSync } from "fs";
import { basename } from "path";
import { randomUUID } from "node:crypto";
import type { ApiClient } from "@shared/api";
import { DIM, GREEN, RESET } from "./colors";
import { getEnv } from "./args";
import { fail, findByTitle, matchScore } from "./title-match";

export function printWidgetsHelp() {
  process.stderr.write(`
tfa-cli widgets — the project's board widgets (cards on the board that show something live)

A widget shows a ref: a show block <todoId>:<alias> (a file/html/chart/renderer card, always its
latest version), a todo, or an http(s) url. "Widget" / "kártya" from the user means these.
<widget> is a card id or its title, matched loosely like notes (case, accents, a typo).

Usage:
  tfa-cli widgets [query]                   List: id, title, what it shows, group
  tfa-cli widgets get <widget> [> file]     A show widget: its current file's bytes to stdout
                                            (--json: card + show metadata). todo/url: the ref
  tfa-cli widgets set <widget> <file|->     New bytes for the show behind it: the card updates in place
                                            (filename, type, renderer, link kept; - = stdin). File shows only
  tfa-cli widgets add <ref|alias> [--title T] [--group <slug>]
                                            Put a show (alias = in this todo), todo or url on the board
  tfa-cli widgets rename <widget> -- "title"   Rename the card ("" = follow the show's title)
  tfa-cli widgets rm <widget>               Take it off the board (id or exact title; the show stays)

A renderer widget (show list says renderer=<name>): the show file is its data (often JSON), the
renderer is its HTML template, shared by every widget using it: tfa-surface card get|add <name>.

Examples:
  tfa-cli widgets get "sajtó" > data.json && jq … data.json > new.json && tfa-cli widgets set "sajtó" new.json
  tfa-show chart.png --alias kpi && tfa-cli widgets add kpi --title "Weekly KPIs" --group marketing
`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

/** `<todoId>:<key>` → the show it names; anything else (todo id, url) isn't a show. */
export const showRefOf = (ref: string) => {
  const i = ref.indexOf(":");
  return i > 0 && UUID.test(ref.slice(0, i)) ? { todoId: ref.slice(0, i), key: ref.slice(i + 1) } : undefined;
};

/** The name the board shows: a rename on the card, else the show's title, file, url host, else the ref. */
export function widgetTitle(w: any): string {
  const show = w.show ?? {};
  const renamed = w.title && w.title !== show.title && w.title !== show.filename;
  return (renamed && w.title) || show.title || (show.filename && basename(show.filename)) || (show.url && hostOf(show.url)) || w.title || w.todoTitle || (/^https?:\/\//i.test(w.ref) ? hostOf(w.ref) : w.ref);
}

const kindOf = (w: any) => {
  if (/^https?:\/\//i.test(w.ref)) return "url";
  if (!showRefOf(w.ref)) return "todo";
  const s = w.show ?? {};
  return s.cardRef ? `renderer=${s.cardRef}` : s.url ? `url ${hostOf(s.url)}` : s.mime || "show";
};

export async function widgetsCommand(api: ApiClient, positionals: string[], args: Record<string, any>, projectId?: string) {
  if (!projectId) fail("No project — pass --project <id> or set TODOFORAI_PROJECT_ID");
  const [, verb, target, ...rest] = positionals;
  const widgets = (await api.listProjectSurfaces(projectId!)).filter((s: any) => s.ref);
  // A todo widget is named by its todo's title on the board: fetch those (few) so it is findable by name.
  await Promise.all(widgets.filter((w: any) => UUID.test(w.ref)).map(async (w: any) => { w.todoTitle = (await api.getTodo(w.ref).catch(() => null))?.content?.split("\n")[0]?.slice(0, 80); }));
  const find = (q: string, exact = false) => findByTitle(widgets, q, widgetTitle, exact, "widget");

  if (!verb || !["get", "set", "add", "rename", "rm"].includes(verb)) {
    const query = positionals.slice(verb === "list" ? 2 : 1).join(" ");
    const shown = query ? widgets.filter((w: any) => matchScore(w.id, widgetTitle(w), query) !== undefined) : widgets;
    if (args.json) { console.log(JSON.stringify(shown, null, 2)); return; }
    for (const w of shown) console.log(`${w.id}  ${widgetTitle(w)}  ${DIM}${[kindOf(w), w.ref, w.group && `in ${w.group}`].filter(Boolean).join("  ")}${RESET}`);
    return;
  }
  if (!target) fail(`Usage: tfa-cli widgets ${verb} <${verb === "add" ? "ref|alias" : "widget"}>${verb === "set" ? " <file|->" : verb === "rename" ? ' -- "title"' : ""}`);

  if (verb === "add") {
    const here = getEnv("TODO_ID");
    const ref = UUID.test(target) || /^https?:\/\//i.test(target) || showRefOf(target) ? target : here ? `${here}:${target}` : fail("A bare alias needs a current todo: pass <todoId>:<alias>");
    if (showRefOf(ref)) { const { todoId, key } = showRefOf(ref)!; await api.getShowBlock(todoId, key); } // fail now on a wrong ref, not as a broken card
    const group = args.group as string | undefined;
    const same = widgets.find((w: any) => w.ref === ref && (w.group ?? undefined) === group);
    const id = same?.id ?? `widget-${randomUUID().slice(0, 8)}`;
    const w = await api.upsertProjectSurface(projectId!, id, { ref, ...(args.title ? { title: args.title } : {}), ...(group ? { group } : {}) });
    if (args.json) { console.log(JSON.stringify(w, null, 2)); return; }
    process.stderr.write(`${GREEN}✅ widget ${id} ${same ? "updated" : "added"}: ${ref}${group ? ` in ${group}` : ""}${RESET}\n`);
    return;
  }

  const w = verb === "rm" || verb === "get" ? find([target, ...rest].join(" "), verb === "rm") : find(target);
  if (verb === "rm") {
    await api.deleteProjectSurface(projectId!, w.id);
    process.stderr.write(`${GREEN}✅ widget "${widgetTitle(w)}" taken off the board (its show stays)${RESET}\n`);
    return;
  }
  if (verb === "rename") {
    await api.upsertProjectSurface(projectId!, w.id, { title: rest.join(" ") });
    process.stderr.write(`${GREEN}✅ widget ${w.id} ${rest.join(" ").trim() ? `renamed "${rest.join(" ")}"` : "follows its show's title"}${RESET}\n`);
    return;
  }

  const show = showRefOf(w.ref);
  if (!show) {
    if (verb === "set") fail(`"${widgetTitle(w)}" shows ${w.ref}, not a file: edit that todo/page itself`);
    console.log(args.json ? JSON.stringify(w, null, 2) : w.ref);
    return;
  }
  const { block } = await api.getShowBlock(show.todoId, show.key);
  if (verb === "get") {
    if (args.json) { console.log(JSON.stringify({ widget: w, show: { ...block, results: undefined } }, null, 2)); return; }
    if (block.url || block.ref) { console.log(block.url || block.ref); return; }
    process.stdout.write(await api.showContent(show.todoId, block.alias || block.id));
    return;
  }
  // set: new bytes for the same block; the backend keeps everything else (renderer, filename, mime, device, link).
  const src = rest[0] ?? fail("Usage: tfa-cli widgets set <widget> <file|->");
  const chunks: Buffer[] = [];
  if (src === "-") for await (const c of process.stdin) chunks.push(c as Buffer);
  const bytes = src === "-" ? Buffer.concat(chunks) : readFileSync(src);
  if (!bytes.length) fail("Empty content");
  const res = await api.replaceShowContent(show.todoId, block.alias || block.id, bytes);
  if (args.json) { console.log(JSON.stringify(res, null, 2)); return; }
  process.stderr.write(`${GREEN}✅ widget "${widgetTitle(w)}" updated (new version of ${res.ref})${RESET}\n`);
}
