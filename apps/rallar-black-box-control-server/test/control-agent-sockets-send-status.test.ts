import { expect, test } from 'bun:test';

import { ControlAgentSockets, type ControlAgentSocketService } from '../src/control-agent-sockets.ts';

/** Bun's `ServerWebSocket.send` status for a frame it dropped. */
const DROPPED = 0;

const idleService: ControlAgentSocketService = {
    recordDuplicateAgentSocketReplacement: () => undefined,
    takeDispatchableCommandsForAgents: () => new Map(),
    takeBarrierResolutions: () => []
};

test('a result release whose frame the socket dropped fails at once instead of waiting out the acknowledgement', async () => {
    const sockets = new ControlAgentSockets(idleService);
    sockets.register({ readyState: 1, send: () => DROPPED, close: () => undefined }, { runId: 'run-1', agentId: 'agent-1' });

    const outcome = await Promise.race([
        sockets.requestResultRelease({
            kind: 'results.release',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'agent-1',
            requestId: 'release-1',
            receipts: []
        }, AbortSignal.timeout(5_000)),
        Bun.sleep(1_000).then(() => 'still-waiting' as const)
    ]);

    expect(outcome === 'still-waiting' ? outcome : outcome.left).toBe('The agent socket dropped the release request.');
});
