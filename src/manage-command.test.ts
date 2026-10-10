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
