import { afterEach, expect, mock, test } from 'bun:test';
import { machineCommand } from './machine-command';

const PLAN = { memoryGb: 1, vcpus: 2, diskGb: 8 };
const state = (upgrade: object | null = null) => ({ plan: PLAN, upgrade, pendingDisk: null, dailyUsd: 0, monthlyUsd: 0, payerId: 'me' });
const client = (apiKey: string, upgrade: object | null = null) => ({
  apiKey,
  getMachineSize: mock(async () => state(upgrade)),
  setMachineSize: mock(async (r: object | null) => state(r)),
  proposeMachineSize: mock(async () => ({ messageId: 'm', blockId: 'b', ref: 't:b' })),
  getTeams: mock(async () => [
    { ownerId: 'o', ownerEmail: 'boss@x.io', canManage: true, members: [{ id: 'm1', email: 'Dev@x.io' }] },
    { ownerId: 'o2', ownerEmail: 'other@x.io', canManage: false, members: [{ id: 'm2', email: 'nope@x.io' }] },
  ]),
});
const exit = mock((code?: number) => { throw new Error(`exit ${code}`); });
process.exit = exit as any;
process.stderr.write = (() => true) as any;
process.stdout.write = (() => true) as any;
Object.defineProperty(process.stdin, 'isTTY', { value: false });
afterEach(() => { delete process.env.TODOFORAI_TODO_ID; });

test('no flags only reads', async () => {
  const api = client('key');
  await machineCommand(api as any, ['machine', 'size'], {});
  expect(api.getMachineSize).toHaveBeenCalledWith({});
  expect(api.setMachineSize).not.toHaveBeenCalled();
});

test('--disk keeps the other dimensions and applies with --yes', async () => {
  const api = client('key', { memoryGb: 4, vcpus: 2, diskGb: 8 });
  await machineCommand(api as any, ['machine', 'size'], { disk: '20', yes: true });
  expect(api.setMachineSize).toHaveBeenCalledWith({ memoryGb: 4, vcpus: 2, diskGb: 20 }, {});
});

test('the plan size clears the upgrade', async () => {
  const api = client('key', { memoryGb: 1, vcpus: 2, diskGb: 20 });
  await machineCommand(api as any, ['machine', 'size'], { plan: true, yes: true });
  expect(api.setMachineSize).toHaveBeenCalledWith(null, {});
});

test('an unsupported size or a non-interactive resize without --yes is refused', async () => {
  await expect(machineCommand(client('key') as any, ['machine', 'size'], { disk: '25', yes: true })).rejects.toThrow('exit 2');
  await expect(machineCommand(client('key') as any, ['machine', 'size'], { memory: '0.5', yes: true })).rejects.toThrow('exit 2');
  const api = client('key');
  await expect(machineCommand(api as any, ['machine', 'size'], { disk: '20' })).rejects.toThrow('exit 2');
  expect(api.setMachineSize).not.toHaveBeenCalled();
});

test('an agent shell only posts an approval card, even with --yes', async () => {
  process.env.TODOFORAI_TODO_ID = 't1';
  const api = client('dst_abc');
  await machineCommand(api as any, ['machine', 'size'], { disk: '20', yes: true, reason: 'disk full' });
  expect(api.setMachineSize).not.toHaveBeenCalled();
  expect(api.proposeMachineSize).toHaveBeenCalledWith('t1', { memoryGb: 1, vcpus: 2, diskGb: 20 }, { reason: 'disk full' });
});

test('--for sizes a member on a workspace the caller manages', async () => {
  const api = client('key');
  await machineCommand(api as any, ['machine', 'size'], { for: 'dev@x.io', memory: '4', yes: true });
  expect(api.getMachineSize).toHaveBeenCalledWith({ ownerId: 'o', userId: 'm1' });
  expect(api.setMachineSize).toHaveBeenCalledWith({ memoryGb: 4, vcpus: 2, diskGb: 8 }, { ownerId: 'o', userId: 'm1' });
  await expect(machineCommand(client('key') as any, ['machine', 'size'], { for: 'nope@x.io' })).rejects.toThrow('exit 2');
});

test('the same size moves a self-paid upgrade onto the workspace, else is a no-op', async () => {
  const up = { memoryGb: 4, vcpus: 2, diskGb: 8 };
  const api = client('key', up);
  await machineCommand(api as any, ['machine', 'size'], { memory: '4', yes: true });
  expect(api.setMachineSize).not.toHaveBeenCalled();
  await machineCommand(api as any, ['machine', 'size'], { for: 'dev@x.io', memory: '4', yes: true });
  expect(api.setMachineSize).toHaveBeenCalledWith(up, { ownerId: 'o', userId: 'm1' });
});

test('an agent shell cannot name a teammate', async () => {
  process.env.TODOFORAI_TODO_ID = 't1';
  const api = client('dst_abc');
  await expect(machineCommand(api as any, ['machine', 'size'], { for: 'dev@x.io', disk: '20' })).rejects.toThrow('exit 2');
  expect(api.getTeams).not.toHaveBeenCalled();
});
