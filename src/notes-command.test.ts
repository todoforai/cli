import { expect, mock, test } from 'bun:test';
import { findNote, notesCommand } from './notes-command';

const notes = [
  { id: 'note-1', title: 'vide hack', body: 'https://x.com/a\nr' },
  { id: 'note-2', title: 'hacks video view', body: 'x' },
  { id: 'note-3', body: 'Bevásárlás\ntej' },
  { id: 'w-1', ref: 'abc', title: 'vibe hack widget' },
];

const plain = notes.filter(n => !n.ref);

test('findNote matches a dictation typo, accents and substrings', () => {
  expect(findNote(plain, 'vibe hack').id).toBe('note-1');
  expect(findNote(plain, 'Vide Hack').id).toBe('note-1');
  expect(findNote(plain, 'bevasarlas').id).toBe('note-3');
  expect(findNote(plain, 'video').id).toBe('note-2');
  expect(findNote(plain, 'vibe').id).toBe('note-1');
  expect(findNote(plain, 'vide hack', true).id).toBe('note-1');
});

test('append adds a line to the matched note, never to a ref card', async () => {
  const api = { listProjectSurfaces: async () => notes, upsertProjectSurface: mock(async (_p: string, id: string, f: any) => ({ id, ...f })) };
  await notesCommand(api as any, ['notes', 'append', 'vibe hack', '- Meeting', 'csütörtök'], {}, 'p');
  expect(api.upsertProjectSurface).toHaveBeenLastCalledWith('p', 'note-1', { body: 'https://x.com/a\nr\n- Meeting csütörtök' });
  await notesCommand(api as any, ['notes', 'edit', 'note-3', 'új'], {}, 'p');
  expect(api.upsertProjectSurface).toHaveBeenLastCalledWith('p', 'note-3', { body: 'új' });
});

test('the text after -- keeps a leading markdown dash', async () => {
  const { parseCliArgs } = await import('./args');
  const argv = process.argv;
  process.argv = ['bun', 'tfa-cli', 'notes', 'append', 'vibe hack', '--', '- Meeting'];
  try { expect(parseCliArgs().positionals).toEqual(['notes', 'append', 'vibe hack', '- Meeting']); } finally { process.argv = argv; }
});
