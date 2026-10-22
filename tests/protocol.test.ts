import { describe, expect, test } from 'bun:test';
import { ApiError, RpcClient, validEventRendering, validRendererMetadata, type ServerEvent } from '../src/protocol.js';
import { event, mockServer, respond, send, waitFor } from './helpers.js';

describe('Unix JSONL transport', () => {
  test('presentation sidecars validate all additive semantic metadata and reject malformed hints', () => {
    const base = { rendererId: 'core', summary: 'head', extended: 'head\\nstatus', full: 'full' };
    expect(validEventRendering({ ...base, subtype: 'mcp__agentorg__get_operation', canonicalTool: 'get_operation', updateMode: 'semantic', extendedLayout: 'header-detail', toolSymbol: '∴', toolTarget: '@child-1' })).toBe(true);
    expect(validEventRendering({ ...base, toolSymbol: 'way-too-long-symbol', toolTarget: '@child-1' })).toBe(false);
    expect(validEventRendering({ ...base, updateMode: 'tail' })).toBe(false);
    expect(validEventRendering({ ...base, extendedLayout: 'header-first' })).toBe(false);
    expect(validEventRendering({ ...base, extendedDiff: { prefix: 'a', before: 1, after: 'b' } })).toBe(false);
    const emitted = 'mcp__agentorg__get_operation';
    const aliasExample = { type: 'tool.result', ...base, raw: JSON.stringify({ kind: 'event', type: 'tool.result', data: { title: emitted } }), subtype: emitted };
    expect(validRendererMetadata({ id: 'core', name: 'Core', eventTypes: ['tool.result'], tool: 'get_operation', aliases: [emitted], aliasExamples: { [emitted]: [aliasExample] }, updateMode: 'semantic', extendedLayout: 'header-detail', examples: [{ type: 'tool.result', ...base, raw: '{}' }] })).toBe(true);
    expect(validRendererMetadata({ id: 'core', name: 'Core', eventTypes: ['tool.result'], aliases: [emitted], aliasExamples: { 'mcp__other__get_operation': [aliasExample] }, examples: [{ type: 'tool.result', ...base, raw: '{}' }] })).toBe(false);
    expect(validRendererMetadata({ id: 'core', name: 'Core', eventTypes: 'tool.result', examples: [] })).toBe(false);
  });
  test('fragmented UTF-8, CRLF, U+2028, events before responses and out-of-order replies', async () => {
    const requests: any[] = [];
    const mock = await mockServer((socket, request) => {
      requests.push(request);
      if (requests.length !== 2) return;
      const frame = Buffer.from(JSON.stringify(event(1, 'plugin.new', { text: '🦊\nline\u2028separator' })) + '\r\n');
      const split = frame.indexOf(Buffer.from('🦊')) + 2;
      socket.write('\n'); socket.write(frame.subarray(0, split));
      setTimeout(() => {
        socket.write(frame.subarray(split));
        respond(socket, requests[1].id, { second: true });
        respond(socket, requests[0].id, { first: true });
      }, 5);
    });
    const client = new RpcClient(mock.path);
    const events: ServerEvent[] = [];
    client.on('event', e => events.push(e));
    try {
      await client.connect();
      const first = client.request('first', { text: 'escaped\nnewline' });
      const second = client.request('second');
      expect(await second).toEqual({ second: true });
      expect(events).toHaveLength(1);
      expect((events[0]!.data as any).text).toBe('🦊\nline\u2028separator');
      expect(await first).toEqual({ first: true });
      expect(requests[0].params.text).toBe('escaped\nnewline');
      expect(requests[0]).not.toHaveProperty('token');
      expect(requests[0]).not.toHaveProperty('jsonrpc');
    } finally { client.close(); await mock.close(); }
  });
  test('correlated errors and id:null diagnostics are independent', async () => {
    const mock = await mockServer((socket, request) => {
      send(socket, { kind: 'response', id: null, ok: false, error: { code: 'LIMIT', message: 'global' } });
      send(socket, { kind: 'response', id: request.id, ok: false, error: { code: 'NOT_RUNNING', message: 'stopped' } });
    });
    const client = new RpcClient(mock.path);
    const diagnostics: string[] = [];
    client.on('diagnostic', message => diagnostics.push(message));
    try {
      await client.connect();
      const error = await client.request('agent.prompt').catch(error => error);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('NOT_RUNNING');
      expect(diagnostics).toEqual(['LIMIT: global']);
    } finally { client.close(); await mock.close(); }
  });
  test('disconnect rejects pending work with unknown outcome, does not process unterminated EOF', async () => {
    const mock = await mockServer((socket, request) => {
      socket.end(JSON.stringify({ kind: 'response', id: request.id, ok: true, result: true }));
    });
    const client = new RpcClient(mock.path);
    try {
      await client.connect();
      await expect(client.request('agent.prompt')).rejects.toThrow('outcome unknown');
    } finally { client.close(); await mock.close(); }
  });
  test('oversized and invalid frames disconnect safely', async () => {
    for (const frame of ['x'.repeat(101), 'not json\n', ' \n']) {
      const mock = await mockServer(() => {}, socket => socket.write(frame));
      const client = new RpcClient(mock.path, 100);
      const diagnostics: string[] = [];
      client.on('diagnostic', message => diagnostics.push(message));
      let disconnected = false;
      client.on('disconnect', () => { disconnected = true; });
      try {
        await client.connect();
        await waitFor(() => disconnected);
        expect(diagnostics.length).toBeGreaterThan(0);
      } finally { client.close(); await mock.close(); }
    }
  });
  test('request timeout never automatically resends a mutation', async () => {
    let count = 0;
    const mock = await mockServer(() => { count++; });
    const client = new RpcClient(mock.path);
    try {
      await client.connect();
      await expect(client.request('agent.prompt', {}, 20)).rejects.toThrow('outcome unknown');
      expect(count).toBe(1);
    } finally { client.close(); await mock.close(); }
  });
});
