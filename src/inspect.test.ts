import { test, expect } from 'bun:test';
import { toAnthropicShape } from './inspect';

test('orchestrator shell inspection preserves the actual command and output', () => {
  const messages = [{ role: 'assistant', blocks: [{
    id: 'b', type: 'named_tool', tool_name: 'run_shell', args: { cmd: 'date\nprintf done' },
    status: 'COMPLETED', results: [{ attachments: [], meta: { success: true, text: '[exit 0]\ntoday' } }],
  }] }];
  const [compact] = toAnthropicShape(messages);
  expect(compact.content[0].content).toBe('<bash cmd="date\\nprintf done"/>');
  expect(compact.content[1].content).toBe('[exit 0]\ntoday');
  const [assistant, result] = toAnthropicShape(messages, 'detailed', 'anthropic');
  expect(assistant.content[0]).toMatchObject({ type: 'tool_use', name: 'bash', input: { cmd: 'date\nprintf done' } });
  expect(result.content[0].content).toEqual([{ type: 'text', text: '[exit 0]\ntoday' }]);
});

test('ordinary shell inspection remains unchanged', () => {
  const [assistant] = toAnthropicShape([{ role: 'assistant', blocks: [{ id: 'b', type: 'bash', cmd: 'date', status: 'COMPLETED', results: [{ content: 'today', attachments: [] }] }] }]);
  expect(assistant.content[0].content).toBe('<bash cmd="date"/>');
  expect(assistant.content[1].content).toBe('today');
});
