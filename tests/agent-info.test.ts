import { expect, test } from 'bun:test';
import { renderAgentInfo } from '../src/agent-info.js';
import { agent } from './helpers.js';

test('agent info includes every public field, session identity and nested plugin data', () => {
  const record = agent('worker', 'root', {
    sessionId: 'session-123', sessionNumber: 4, createdAt: 'created-time', updatedAt: 'updated-time',
    error: { code: 'FAILED', message: 'first line\nsecond line' },
    settings: { harness: 'fixture', cwd: '/work', env: { API_URL: 'https://example.test' }, extensions: { podman: { containerId: 'container-123', mounts: [{ source: '/src', target: '/dst' }] } } },
    metadata: { camelCaseKey: 'preserve-key', skills: ['one', 'two'], note: 'a\nb' },
    futureState: { enabled: false, count: 0, emptyString: '', emptyList: [], emptyMap: {}, nothing: null },
  });
  const text = renderAgentInfo(record);
  for (const field of ['Name: worker', 'Parent ID: root', 'Revision: 1', 'Created: created-time', 'Updated: updated-time', 'Session ID: session-123', 'Session number: 4', 'Generation: g1', 'code: FAILED', 'message:\n      first line\n      second line', 'API_URL: https://example.test', 'containerId: container-123', 'source: /src', 'target: /dst', 'camelCaseKey: preserve-key', '• one', '• two', 'note:\n      a\n      b', 'enabled: false', 'count: 0', 'emptyString: ""', 'emptyList: []', 'emptyMap: {}', 'nothing: null']) expect(text).toContain(field);
  expect(text).not.toContain('[object Object]');
  expect(text).not.toContain('camel Case Key');
  expect(text).toContain('ADDITIONAL AGENT STATE\n  futureState:');
  expect(JSON.parse(renderAgentInfo(record, true))).toEqual(record);
});

test('readable agent info handles minimal records, multiline values and terminal commands safely', () => {
  const record = agent('root', null, {
    name: '\x1b[31mred\x1b[0m\x1b]0;remote-title\x07',
    metadata: { 'key\nwith\nlines': 'first\n\nlast', '': '', control: '\x9b31m' },
    error: '\x1b[2Jfailure',
  });
  const text = renderAgentInfo(record);
  expect(text).toContain('Name: red');
  expect(text).toContain('Parent ID: null');
  expect(text).toContain('Error: failure');
  expect(text).toContain('"key\\nwith\\nlines":\n      first\n      \n      last');
  expect(text).toContain('"": ""');
  expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  expect(text).not.toContain('remote-title');
  expect(text).not.toContain('undefined');
  const raw = renderAgentInfo(record, true);
  expect(raw).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  expect(JSON.parse(raw)).toEqual(record);
});

test('agent info does not truncate long or deeply nested values', () => {
  const value = 'long value '.repeat(1000) + 'END_MARKER';
  const record = agent('root', null, { metadata: { nested: [[{ value }], [], {}] } });
  expect(renderAgentInfo(record)).toContain(value);
  expect(JSON.parse(renderAgentInfo(record, true))).toEqual(record);
});
