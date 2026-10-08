import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Operation, ServerEvent } from '../src/protocol.js';

export const agent = (id: string, parentId: string | null = null, extra: Partial<Agent> = {}): Agent => ({
  id, parentId, name: id, state: 'idle', settings: { model: 'gpt-6-luna', harness: 'pi' },
  revision: 1, generation: 'g1', removedAt: null, ...extra,
});
export const event = (seq: number, type = 'agent.message', data: unknown = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `text ${seq}` } }, extra: Partial<ServerEvent> = {}): ServerEvent => ({
  kind: 'event', seq, time: '2026-10-08T06:00:00.000Z', type, agentId: 'root', generation: 'g1', data, ...extra,
});
export const operation = (status: string): Operation => ({ id: 'op', agentId: 'root', type: 'agent.prompt', status, input: {} });
export const send = (socket: Socket, frame: unknown) => socket.write(JSON.stringify(frame) + '\n');
export const respond = (socket: Socket, id: string, result: unknown) => send(socket, { kind: 'response', id, ok: true, result });
export const waitFor = async (predicate: () => boolean, timeout = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
export async function mockServer(handler: (socket: Socket, request: any) => void, onConnect?: (socket: Socket) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'org-tui-'));
  const path = join(directory, 'server.sock');
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        handler(socket, JSON.parse(line));
      }
    });
    onConnect?.(socket);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return {
    path, directory, sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
