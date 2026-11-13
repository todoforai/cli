/** `notes` — the project's Notes (note cards on the board, i.e. surfaces without a ref), addressed by title. */

import { randomUUID } from "node:crypto";
import type { ApiClient } from "@shared/api";
import { DIM, GREEN, RESET } from "./colors";
import { readStdin } from "./input";
import { fail, findByTitle, matchScore } from "./title-match";

export function printNotesHelp() {
  process.stderr.write(`
tfa-cli notes — the project's Notes (the note cards on the board, in the app)

"Notes" / "jegyzet" from the user means these, not local files.
<note> is an id or a title; titles match loosely (case, accents, a dictation typo: "vibe hack" finds "vide hack").

Usage:
  tfa-cli notes [query]                     List notes: id, title, group (query filters by title)
  tfa-cli notes get <note>                  Print its text (markdown)
  tfa-cli notes append <note> -- "text"|-   Add a line at the end (- = stdin)
  tfa-cli notes edit <note> -- "text"|-     Replace its text
  tfa-cli notes new "<title>" -- ["text"|-] [--group <slug>]   Create one
  tfa-cli notes rm <note>                   Move it to the Trash (id or exact title only)

Put -- before the text: without it a text starting with "-" (a markdown list item) is read as flags.

Examples:
  tfa-cli notes append "vibe hack" -- "- Meeting: Thursday 2026-11-12"
  tfa-cli notes get vibe --json
`);
}



export const noteTitle = (n: any): string => n.title || (n.body ?? "").split("\n").find((l: string) => l.trim())?.trim().slice(0, 60) || "";

export const findNote = (notes: any[], query: string, exact = false) => findByTitle(notes, query, noteTitle, exact);

const textArg = async (rest: string[]) => (rest.length === 1 && rest[0] === "-" ? await readStdin() : rest.join(" "));

export async function notesCommand(api: ApiClient, positionals: string[], args: Record<string, any>, projectId?: string) {
  if (!projectId) fail("No project — pass --project <id> or set TODOFORAI_PROJECT_ID");
  const [, verb, target, ...rest] = positionals;
  const text = ["append", "edit", "new"].includes(verb) ? await textArg(rest) : "";
  const notes = (await api.listProjectSurfaces(projectId!)).filter((s: any) => !s.ref);
  const print = (n: any) => { if (args.json) console.log(JSON.stringify(n, null, 2)); };

  if (!verb || !["get", "append", "edit", "new", "rm"].includes(verb)) {
    const query = positionals.slice(verb === "list" ? 2 : 1).join(" ");
    const shown = query ? notes.filter((n: any) => matchScore(n.id, noteTitle(n), query) !== undefined) : notes;
    if (args.json) { console.log(JSON.stringify(shown, null, 2)); return; }
    for (const n of shown) console.log(`${n.id}  ${noteTitle(n)}${n.group ? `  ${DIM}in ${n.group}${RESET}` : ""}`);
    return;
  }
  if (!target) fail(`Usage: tfa-cli notes ${verb} <note>${verb === "get" || verb === "rm" ? "" : ' -- "text"|-'}`);

  if (verb === "new") {
    const body = text || target;
    const note = await api.upsertProjectSurface(projectId!, `note-${randomUUID().slice(0, 8)}`, { title: target, body, ...(args.group ? { group: args.group } : {}) });
    print(note);
    process.stderr.write(`${GREEN}✅ note "${target}" created (${note.id})${RESET}\n`);
    return;
  }
  const note = verb === "append" || verb === "edit" ? findNote(notes, target) : findNote(notes, [target, ...rest].join(" "), verb === "rm");
  if (verb === "get") { if (args.json) print(note); else console.log(note.body ?? ""); return; }
  if (verb === "rm") {
    await api.deleteProjectSurface(projectId!, note.id);
    process.stderr.write(`${GREEN}✅ note "${noteTitle(note)}" moved to the Trash${RESET}\n`);
    return;
  }
  if (!text.trim()) fail(`Usage: tfa-cli notes ${verb} <note> -- "text"|-`);
  const old = note.body ?? "";
  const body = verb === "edit" ? text : old ? `${old.replace(/\n*$/, "")}\n${text}` : text;
  const saved = await api.upsertProjectSurface(projectId!, note.id, { body });
  print(saved);
  process.stderr.write(`${GREEN}✅ note "${noteTitle(note)}" ${verb === "edit" ? "replaced" : "appended"} (${note.id})${RESET}\n`);
}
