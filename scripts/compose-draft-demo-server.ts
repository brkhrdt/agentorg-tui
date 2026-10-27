import { createServer, type Socket } from 'node:net';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const socketPath = resolve(process.argv[2] ?? 'compose-draft-demo-server.sock');
const agents = [
  { id: 'coordinator', parentId: null, name: 'Coordinator', state: 'idle', settings: { model: 'demo', harness: 'pi' }, revision: 1, generation: 'demo-1', removedAt: null },
  { id: 'writer', parentId: 'coordinator', name: 'Writer', state: 'idle', settings: { model: 'demo', harness: 'pi' }, revision: 1, generation: 'demo-1', removedAt: null },
  { id: 'reviewer', parentId: 'coordinator', name: 'Reviewer', state: 'idle', settings: { model: 'demo', harness: 'pi' }, revision: 1, generation: 'demo-1', removedAt: null },
];
let opId = 0;
const server = createServer(socket => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      const response = (result: unknown) => socket.write(JSON.stringify({ kind: 'response', id: request.id, ok: true, result }) + '\n');
      if (request.method === 'organization.snapshot') response({ seq: 0, agents, operations: [] });
      else if (request.method === 'events.history') response({ events: [], oldestSeq: 0, latestSeq: 0, expired: false, hasMore: false });
      else if (request.method === 'agent.prompt') {
        const id = `demo-prompt-${++opId}`;
        console.log(`[accepted] ${request.params.agentId}: ${request.params.text}`);
        response({ id, agentId: request.params.agentId, type: 'agent.prompt', status: 'running', input: { text: request.params.text } });
      } else response({});
    }
  });
});
await rm(socketPath, { force: true });
server.listen(socketPath, () => console.log(`Demo server listening at ${socketPath} (Ctrl-C to stop)`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
