/** `notes` — the project's Notes (note cards on the board, i.e. surfaces without a ref), addressed by title. */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  tfa-cli notes edit <note> -- "text"|-     Replace its text (refused if it changed since your last get: get it again)
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

// The version of each note this todo last read (get) or wrote: `edit` replaces only that one, so a change made in
// between (by the user, another task) is never overwritten unseen. Per todo: each agent run is its own reader.
const seenFile = () => join(homedir(), ".todoforai", "notes-seen", `${process.env.TODOFORAI_TODO_ID || "shell"}.json`);
const seenAll = (): Record<string, number> => { try { return JSON.parse(readFileSync(seenFile(), "utf8")); } catch { return {}; } };
const seen = (id: string): number | undefined => seenAll()[id];
const remember = (id: string, updatedAt = 0) => {
  try { mkdirSync(join(homedir(), ".todoforai", "notes-seen"), { recursive: true }); writeFileSync(seenFile(), JSON.stringify({ ...seenAll(), [id]: updatedAt })); } catch {}
};

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
    remember(note.id, note.updatedAt);
    print(note);
    process.stderr.write(`${GREEN}✅ note "${target}" created (${note.id})${RESET}\n`);
    return;
  }
  const note = verb === "append" || verb === "edit" ? findNote(notes, target) : findNote(notes, [target, ...rest].join(" "), verb === "rm");
  if (verb === "get") { remember(note.id, note.updatedAt); if (args.json) print(note); else console.log(note.body ?? ""); return; }
  if (verb === "rm") {
    await api.deleteProjectSurface(projectId!, note.id);
    process.stderr.write(`${GREEN}✅ note "${noteTitle(note)}" moved to the Trash${RESET}\n`);
    return;
  }
  if (!text.trim()) fail(`Usage: tfa-cli notes ${verb} <note> -- "text"|-`);
  const old = note.body ?? "";
  const body = verb === "edit" ? text : old ? `${old.replace(/\n*$/, "")}\n${text}` : text;
  // edit: built on the version this todo last read (never read: the one just fetched); append: on the one just
  // fetched. Changed since ⇒ CONFLICT instead of an overwrite.
  const base = (verb === "edit" ? seen(note.id) : undefined) ?? note.updatedAt ?? 0;
  if (verb === "edit" && base !== (note.updatedAt ?? 0)) {
    remember(note.id, note.updatedAt);
    fail(`Not saved: "${noteTitle(note)}" was changed by someone else since you read it. Its text now:\n\n${old}\n\nRedo your edit on top of this text, then run the edit again.`);
  }
  const saved = await api.upsertProjectSurface(projectId!, note.id, { body, baseUpdatedAt: base }).catch((e: Error) => {
    if (!/NOTE_CHANGED|CONFLICT|409/.test(e.message)) throw e;
    fail(`Not saved: "${noteTitle(note)}" changed while saving. Run \`tfa-cli notes get ${note.id}\`, redo your edit on top of it, then save again.`);
  });
  remember(note.id, saved.updatedAt);
  print(saved);
  process.stderr.write(`${GREEN}✅ note "${noteTitle(note)}" ${verb === "edit" ? "replaced" : "appended"} (${note.id})${RESET}\n`);
}
