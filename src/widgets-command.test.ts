import { expect, mock, test } from 'bun:test';
import { widgetTitle, widgetsCommand } from './widgets-command';

const T = 'd422b306-2725-4a03-a370-91c97fa20443';
const surfaces = [
  { id: 'note-1', title: 'sajtó jegyzet', body: 'x' },
  { id: 'sajtofigyeles', ref: `${T}:sajtofigyeles`, show: { title: 'Sajtófigyelés', filename: 'sajtofigyeles.json', cardRef: 'sajtofigyeles' } },
  { id: 'kpi', ref: `${T}:0932ab09-b191-420a-bbee-802df12d456d`, title: 'Weekly KPIs', show: { title: 'chart', filename: 'c.png' } },
  { id: 'site', ref: 'https://todofor.ai/x' },
];

test('a widget is named by its rename, else its show', () => {
  expect(widgetTitle(surfaces[1])).toBe('Sajtófigyelés');
  expect(widgetTitle(surfaces[2])).toBe('Weekly KPIs');
  expect(widgetTitle(surfaces[3])).toBe('todofor.ai');
});

test('set sends new bytes to the block address; rm takes only an exact title', async () => {
  const replaceShowContent = mock(async () => ({ ref: 'r', attachmentId: 'a' }));
  const deleteProjectSurface = mock(async () => null);
  const api = {
    listProjectSurfaces: async () => surfaces,
    getShowBlock: async (_t: string, key: string) => ({ block: key === 'sajtofigyeles' ? { id: 'b1', alias: 'sajtofigyeles' } : { id: 'blk' } }),
    replaceShowContent, deleteProjectSurface,
  };
  await widgetsCommand(api as any, ['widgets', 'set', 'sajto', 'package.json'], {}, 'p');
  expect(replaceShowContent.mock.calls[0].slice(0, 2)).toEqual([T, 'sajtofigyeles']);
  await widgetsCommand(api as any, ['widgets', 'set', 'weekly kpis', 'package.json'], {}, 'p');
  expect(replaceShowContent.mock.calls[1].slice(0, 2)).toEqual([T, 'blk']);
  await widgetsCommand(api as any, ['widgets', 'rm', 'Sajtófigyelés'], {}, 'p');
  expect(deleteProjectSurface).toHaveBeenCalledWith('p', 'sajtofigyeles');
});
