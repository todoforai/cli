import { expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { findWorkflowStep, positionText, workflowCommand, workflowText } from './workflow-command';

const wf = {
  id: 'w1', name: 'Számlakezelés', on: true, updatedAt: 1, updatedBy: 'u',
  nodes: [
    { id: 'mail', kind: 'trigger', title: 'Számla jön e-mailben', on: { kind: 'source', source: 'gmail' } },
    { id: 'read', kind: 'run', title: 'AI kiolvassa', script: { kind: 'ai', prompt: 'Olvasd ki' } },
    { id: 'ok', kind: 'trigger', title: 'Gábor ellenőrzi', on: { kind: 'human', buttons: [{ label: 'OK' }, { label: 'Hibás', outcome: 'Hibás' }] } },
  ],
  links: [{ from: 'mail', to: 'read' }, { from: 'read', to: 'ok' }, { from: 'ok', to: 'read', when: 'Hibás' }],
};
const api = () => ({
  listWorkflows: async () => [wf],
  setWorkflow: mock(async (_p: string, w: any) => ({ ...wf, ...w })),
  deleteWorkflow: mock(async () => null),
});

test('workflowText lists every node with its lines', () => {
  const t = workflowText(wf);
  for (const s of ['⚡ mail', 'source gmail', '▶ read', 'ai "Olvasd ki"', 'human [OK] [Hibás]', '→ read', '(Hibás)']) expect(t).toContain(s);
});

test('set sends the file without the stored-only fields; on/off/rm find it by a loose name', async () => {
  const a = api();
  const file = '/tmp/wf-cli-test.json';
  writeFileSync(file, JSON.stringify({ ...wf, generation: 3, projectId: 'x' }));
  await workflowCommand(a as any, ['workflow', 'set', file], {}, 'p');
  const { updatedAt: _a, updatedBy: _b, ...sent } = wf;
  expect(a.setWorkflow).toHaveBeenLastCalledWith('p', sent);
  await workflowCommand(a as any, ['workflow', 'off', 'számlakezelés'], {}, 'p');
  expect(a.setWorkflow).toHaveBeenLastCalledWith('p', { ...sent, on: false });
  await workflowCommand(a as any, ['workflow', 'rm', 'Számlakezelés'], {}, 'p');
  expect(a.deleteWorkflow).toHaveBeenLastCalledWith('p', 'w1');
});

test('"<workflow>:<step>" names a step by id or title; a name holding ":" stays whole', () => {
  const other = { ...wf, id: 'w2', name: 'Ügyfél: onboarding', nodes: [{ id: 'hi', kind: 'run', title: 'Köszöntés', script: { kind: 'ai', prompt: 'x' } }] };
  expect(findWorkflowStep([wf, other], 'Számlakezelés').node).toBeUndefined();
  expect(findWorkflowStep([wf, other], 'w1:read').node.id).toBe('read');
  expect(findWorkflowStep([wf, other], 'számlakezelés: gábor ellenőrzi').node.id).toBe('ok');
  expect(findWorkflowStep([wf, other], 'Ügyfél: onboarding')).toEqual({ w: other });
  expect(findWorkflowStep([wf, other], 'Ügyfél: onboarding:köszöntés').node.id).toBe('hi');
  // The exact name wins over a substring competitor and over a step its suffix names.
  const archive = { ...wf, id: 'w3', name: 'Számlakezelés archívum' };
  expect(findWorkflowStep([wf, archive], 'Számlakezelés:read')).toEqual({ w: wf, node: wf.nodes[1] });
  const clash = { ...other, nodes: [{ id: 'on', kind: 'run', title: 'onboarding', script: { kind: 'ai', prompt: 'x' } }] };
  expect(findWorkflowStep([clash], 'Ügyfél: onboarding')).toEqual({ w: clash });
});

test('todo workflow: each step with what it gave on, here what came in', () => {
  const t = positionText({
    workflowName: 'Számlakezelés', node: { id: 'ok' },
    steps: [
      { node: 'mail', title: 'Számla jön', state: 'done', at: 0, out: { text: 'Invoice #42\nmore', files: [{ id: 'f', originalName: 'a.pdf' }] } },
      { node: 'read', title: 'AI kiolvassa', state: 'done', at: 0, out: {} },
      { node: 'ok', title: 'Gábor ellenőrzi', state: 'here', input: { text: 'Invoice #42\nmore', files: [{ id: 'f', originalName: 'a.pdf' }] } },
      { node: 'pay', title: 'Fizet', state: 'next' },
    ],
    moves: [{ label: 'OK', to: 'pay', toTitle: 'Fizet' }],
  });
  for (const x of ['✓ Számla jön', 'out: "Invoice #42…", files: a.pdf', 'out: nothing', '▶ Gábor ellenőrzi', 'in:  "Invoice #42…", files: a.pdf', 'Fizet  (ahead)', '[OK] → Fizet']) expect(t).toContain(x);
});

test('a run is the todo: todo set workflow= starts, moves into a step, takes it out', async () => {
  const { todoCommand } = await import('./manage-command');
  const a = { listWorkflows: async () => [wf], getTodo: async () => ({ projectId: 'p' }), updateTodo: mock(async () => null), workflowMove: mock(async () => null) };
  await todoCommand(a as any, ['todo', 'set', 't1', 'workflow=Számlakezelés'], { json: true });
  expect(a.workflowMove).toHaveBeenLastCalledWith('t1', 'w1', undefined);
  await todoCommand(a as any, ['todo', 'set', 't1', 'workflow=Számlakezelés:AI kiolvassa', 'title=x'], { json: true });
  expect(a.workflowMove).toHaveBeenLastCalledWith('t1', 'w1', 'read');
  expect(a.updateTodo).toHaveBeenLastCalledWith('t1', { content: 'x' }); // the workflow is no field of the update
  await todoCommand(a as any, ['todo', 'set', 't1', 'workflow='], { json: true });
  expect(a.workflowMove).toHaveBeenLastCalledWith('t1', undefined, undefined);
  expect(a.updateTodo).toHaveBeenCalledTimes(1);
  a.workflowMove = mock(async () => { throw new Error('Stop the run first'); });
  await expect(todoCommand(a as any, ['todo', 'set', 't1', 'workflow=Számlakezelés', 'title=y'], { json: true })).rejects.toThrow('Stop the run first');
  expect(a.updateTodo).toHaveBeenCalledTimes(1);                       // a refused move changes nothing
});

test('list --workflow --node filters on the backend, everyone\'s runs', async () => {
  const { listTodosCommand } = await import('./list-todos');
  const listTodos = mock(async () => ({ items: [], nextCursor: undefined }));
  const a = { listWorkflows: async () => [wf], listTodos, listTodoStates: async () => [] };
  await listTodosCommand(a as any, 'p', ['--workflow', 'Számlakezelés', '--node', 'Gábor ellenőrzi', '--json'], async () => 'me');
  expect(listTodos).toHaveBeenLastCalledWith('p', expect.objectContaining({ workflowId: 'w1', workflowNode: 'ok', contributorIds: undefined }));
});

test('two workflows of the exact name fail, never a split into a third', () => {
  const a = { ...wf, id: 'a', name: 'Billing: Review' }, b = { ...wf, id: 'b', name: 'Billing: Review' };
  const c = { ...wf, id: 'c', name: 'Billing', nodes: [{ id: 'r', kind: 'run', title: 'Review', script: { kind: 'ai', prompt: 'x' } }] };
  const exit = process.exit;
  (process as any).exit = (code: number) => { throw new Error(`exit ${code}`); };
  try { expect(() => findWorkflowStep([a, b, c], 'Billing: Review')).toThrow('exit 2'); } finally { process.exit = exit; }
});

test('two steps of one title fail listing their ids; an id beats a title', () => {
  const twin = { id: 'w9', name: 'Twin', nodes: [{ id: 'a', kind: 'trigger', title: 'Approve' }, { id: 'b', kind: 'trigger', title: 'Approve' }, { id: 'c', kind: 'trigger', title: 'a' }], links: [] };
  const exit = process.exit;
  (process as any).exit = (code: number) => { throw new Error(`exit ${code}`); };
  try { expect(() => findWorkflowStep([twin], 'Twin:Approve')).toThrow('exit 2'); } finally { process.exit = exit; }
  expect(findWorkflowStep([twin], 'Twin:a').node.id).toBe('a');
  expect(findWorkflowStep([twin, { ...twin, id: 'w8', name: 'w9' }], 'w9:c').w.id).toBe('w9');      // an id beats a name
});

test('nothing is guessed: a typo or a part of a name fails, saying what it may have meant', () => {
  const exit = process.exit, write = process.stderr.write;
  let said = '';
  (process as any).exit = (code: number) => { throw new Error(`exit ${code}`); };
  (process.stderr as any).write = (s: string) => { said += s; return true; };
  try {
    expect(() => findWorkflowStep([wf], 'Számlakezlés')).toThrow('exit 2');
    expect(said).toContain('Did you mean');
    expect(said).toContain('w1  Számlakezelés');
    said = '';
    expect(() => findWorkflowStep([wf], 'számla')).toThrow('exit 2');
    expect(() => findWorkflowStep([wf], 'Számlakezelés:AI kiolvas')).toThrow('exit 2');
    expect(said).toContain('read  AI kiolvassa');
  } finally { process.exit = exit; process.stderr.write = write; }
});
