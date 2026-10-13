import { expect, spyOn, test } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { memoryCommand } from './memory-command';

test('memory path exposes only the project and me checkouts and requires a project', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await memoryCommand('https://example.com', 'unused', ['memory', 'path'], 'p');
    expect(log.mock.calls.map(c => c[0])).toEqual([
      join(homedir(), '.todoforai/projects/p/memory'), join(homedir(), '.todoforai/projects/p/context'),
      join(homedir(), '.todoforai/projects/p/me/memory'), join(homedir(), '.todoforai/projects/p/me/context'),
    ]);
    await expect(memoryCommand('https://example.com', 'unused', ['memory', 'path'])).rejects.toThrow('Select a project');
  } finally { log.mockRestore(); }
});
