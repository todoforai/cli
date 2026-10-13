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
