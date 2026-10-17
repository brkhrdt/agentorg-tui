import { expect, test } from 'bun:test';
import { TreeProbe } from '../src/bench-probe.js';
import { agent, event, mockServer, respond, send, waitFor } from './helpers.js';

test('headless TUI probe renders row creation/removal and skips historical replay', async () => {
  let seq = 100000;
  const agents = new Map([['root', agent('root')]]);
  const requests: any[] = [];
  const mock = await mockServer((socket, request) => {
    requests.push(request);
    if (request.method === 'organization.snapshot') respond(socket, request.id, { seq, agents: [...agents.values()], operations: [] });
    else throw new Error(`Unexpected request: ${request.method}`);
  });
  const probe = new TreeProbe(mock.path, 100, 5);
  try {
    probe.start();
    await waitFor(() => probe.report().readyMs !== undefined);
    expect(probe.report().visibleRows).toBe(1);
    for (let i = 0; i < 3; i++) {
      const id = `child-${i}`, child = agent(id, 'root');
      agents.set(id, child);
      for (const socket of mock.sockets) send(socket, event(++seq, 'agent.created', child, { agentId: id, time: new Date().toISOString() }));
      await waitFor(() => probe.report().visibleRows === 2);
      agents.set(id, { ...child, removedAt: new Date().toISOString() });
      for (const socket of mock.sockets) send(socket, event(++seq, 'agent.removed', { removedAt: agents.get(id)!.removedAt }, { agentId: id, time: new Date().toISOString() }));
      await waitFor(() => probe.report().visibleRows === 1);
    }
    const report = probe.report();
    expect(report.rowsAdded).toBe(4);
    expect(report.rowsRemoved).toBe(3);
    expect(report.receivedCreates).toBe(3);
    expect(report.receivedRemoves).toBe(3);
    expect(report.coalescedRowChanges).toBe(0);
    expect(report.distributionsMs.addEventToRender.count).toBe(3);
    expect(report.distributionsMs.removeEventToRender.count).toBe(3);
    expect(report.distributionsMs.render.count).toBeGreaterThan(0);
    expect(requests.every(request => request.method === 'organization.snapshot' && request.params.includeTerminalOperations === false)).toBe(true);
    expect(probe.session.store.historyCursor).toBe(100000);
  } finally { await probe.close(); await mock.close(); }
});
