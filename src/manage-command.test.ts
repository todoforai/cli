import { expect, mock, test } from 'bun:test';
import { deviceCommand } from './manage-command';

test('device leave resolves the shared device and revokes only current-user access', async () => {
  const leaveDevice = mock(async () => null);
  const api = {
    listDevices: async () => [{ id: 'shared-uuid', name: 'Build VM', sharedBy: 'Alice', metadata: {} }],
    leaveDevice,
  };
  await deviceCommand(api as any, ['device', 'leave', 'Build VM'], {});
  expect(leaveDevice).toHaveBeenCalledWith('shared-uuid');
});

test('project group intake routes on/off/read/regenerate without changing other groups', async () => {
  const { projectCommand } = await import('./manage-command');
  const settings = { enabled: true, url: 'https://todofor.ai/in/token', maxSubmissions: 500, submissionCount: 0, autoStart: false };
  const api = {
    updateProjectGroupIntake: mock(async () => settings),
    getProjectGroupIntake: mock(async () => settings),
    regenerateProjectGroupIntake: mock(async () => settings),
  };
  await projectCommand(api as any, ['project', 'groups', 'intake', 'audience', 'on', 'postIpLimit=200', 'maxSubmissions=500'], { json: true }, 'demo');
  expect(api.updateProjectGroupIntake).toHaveBeenLastCalledWith('demo', 'audience', { enabled: true, postIpLimit: 200, maxSubmissions: 500 });
  await projectCommand(api as any, ['project', 'groups', 'intake', 'audience', 'autoStart=false'], { json: true }, 'demo');
  expect(api.updateProjectGroupIntake).toHaveBeenLastCalledWith('demo', 'audience', { autoStart: false });
  await projectCommand(api as any, ['project', 'groups', 'intake', 'audience', 'off'], { json: true }, 'demo');
  expect(api.updateProjectGroupIntake).toHaveBeenLastCalledWith('demo', 'audience', { enabled: false });
  await projectCommand(api as any, ['project', 'groups', 'intake', 'audience'], { json: true }, 'demo');
  expect(api.getProjectGroupIntake).toHaveBeenCalledWith('demo', 'audience');
  await projectCommand(api as any, ['project', 'groups', 'intake', 'audience', 'regenerate'], { json: true }, 'demo');
  expect(api.regenerateProjectGroupIntake).toHaveBeenCalledWith('demo', 'audience');
});

test('voice defaults to mine, allows project and rejects the removed global scope', async () => {
  const { brandCommand } = await import('./manage-command');
  const listVoiceSources = mock(async () => ({ sources: [], profile: null }));
  const api = { listVoiceSources, getBusinessContext: async () => null };
  await brandCommand(api as any, ['brand', 'voice', 'show'], { json: true }, 'p');
  expect(listVoiceSources).toHaveBeenLastCalledWith('p', 'mine');
  await brandCommand(api as any, ['brand', 'voice', 'show'], { json: true, scope: 'project' }, 'p');
  expect(listVoiceSources).toHaveBeenLastCalledWith('p', 'project');
  const { spyOn } = await import('bun:test');
  const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  try {
    await expect(brandCommand(api as any, ['brand', 'voice', 'show'], { scope: 'personal' }, 'p')).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(2);
  } finally { exit.mockRestore(); }
});

test('todo set project= moves the todo, resolving a project name to its id', async () => {
  const { todoCommand } = await import('./manage-command');
  const moveTodoToProject = mock(async () => null);
  const updateTodo = mock(async () => null);
  const api = { listProjects: async () => [{ project: { id: 'p-client', name: 'Client X' } }], moveTodoToProject, updateTodo };
  await todoCommand(api as any, ['todo', 'set', 't1', 'project=client x'], { json: true });
  expect(moveTodoToProject).toHaveBeenCalledWith('t1', 'p-client');
  expect(updateTodo).not.toHaveBeenCalled();
  const exit = process.exit;
  process.exit = ((code: number) => { throw new Error(`exit ${code}`); }) as any;
  try {
    await expect(todoCommand(api as any, ['todo', 'set', 't1', 'project=p-client', 'group=x'], {})).rejects.toThrow('exit 2');
  } finally { process.exit = exit; }
  expect(moveTodoToProject).toHaveBeenCalledTimes(1);
});
