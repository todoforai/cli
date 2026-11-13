import { expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { workflowCommand, workflowText } from './workflow-command';

const wf = {
  id: 'w1', name: 'Számlakezelés', on: true, updatedAt: 1, updatedBy: 'u',
  nodes: [
    { id: 'mail', kind: 'trigger', title: 'Számla jön e-mailben', on: { kind: 'source', source: 'gmail' } },
    { id: 'read', kind: 'run', title: 'AI kiolvassa', script: { kind: 'ai', prompt: 'Olvasd ki' }, inputs: [] },
    { id: 'ok', kind: 'trigger', title: 'Gábor ellenőrzi', on: { kind: 'human', buttons: [{ label: 'OK' }, { label: 'Hibás', outcome: 'Hibás' }] } },
  ],
  links: [{ from: 'mail', to: 'read' }, { from: 'read', to: 'ok' }, { from: 'ok', to: 'read', when: 'Hibás' }],
};
const api = () => ({
  listWorkflows: async () => [wf],
  setWorkflow: mock(async (_p: string, w: any) => ({ ...wf, ...w })),
  deleteWorkflow: mock(async () => null),
  workflowStart: mock(async () => null),
});

test('workflowText lists every node with its lines', () => {
  const t = workflowText(wf);
  for (const s of ['⚡ mail', 'source gmail', '▶ read', 'ai "Olvasd ki"', 'human [OK] [Hibás]', '→ read', '(Hibás)']) expect(t).toContain(s);
});

test('set sends the file without the stored-only fields; on/off/rm/start find it by a loose name', async () => {
  const a = api();
  const file = '/tmp/wf-cli-test.json';
  writeFileSync(file, JSON.stringify({ ...wf, generation: 3, projectId: 'x' }));
  await workflowCommand(a as any, ['workflow', 'set', file], {}, 'p', async (id) => id);
  const { updatedAt: _a, updatedBy: _b, ...sent } = wf;
  expect(a.setWorkflow).toHaveBeenLastCalledWith('p', sent);
  await workflowCommand(a as any, ['workflow', 'off', 'szamlakezeles'], {}, 'p', async (id) => id);
  expect(a.setWorkflow).toHaveBeenLastCalledWith('p', { ...sent, on: false });
  await workflowCommand(a as any, ['workflow', 'start', 't1', 'számla', 'mail'], {}, 'p', async (id) => `todo-${id}`);
  expect(a.workflowStart).toHaveBeenLastCalledWith('todo-t1', 'w1', 'mail');
  await workflowCommand(a as any, ['workflow', 'rm', 'Számlakezelés'], {}, 'p', async (id) => id);
  expect(a.deleteWorkflow).toHaveBeenLastCalledWith('p', 'w1');
});
