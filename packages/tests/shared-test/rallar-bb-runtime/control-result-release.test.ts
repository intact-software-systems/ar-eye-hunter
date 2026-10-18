import { describe, expect, it } from 'vitest';

import { RallarBlackBoxControlClient } from '@shared-test/rallar-bb-test/control-client.ts';
import { computeResultCaptureReceipt } from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { FakeControlSocket } from './fake-control-socket.ts';

const identity = { runId: 'control-release', agentId: 'agent' };

describe('control release acknowledgement', () => {
    it('requires an explicit release message, survives duplicate delivery, and preserves control-only cumulative reports', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        let socket = new FakeControlSocket();
        const client = new RallarBlackBoxControlClient({
            runtime,
            now: Date.now,
            webSocketFactory: () => {
                socket = new FakeControlSocket();
                return socket;
            },
            fetch: globalThis.fetch,
            heartbeatIntervalMs: 60_000,
            statsIntervalMs: 0,
            reconnectBaseMs: 1,
            reconnectMaxMs: 1,
            maxFrameBytes: 2_000_000
        });
        try {
            client.connect({ ...identity, url: 'ws://release.test', completedCommandIds: [] });
            socket.open();
            socket.publishMessage(JSON.stringify({ kind: 'command', protocolVersion: 1, ...identity, commandId: 'first', command: { kind: 'health' } }));
            await expect.poll(() => socket.sent.some((frame) => JSON.parse(frame).kind === 'result')).toBe(true);
            const result = runtime.state().resultCache.first;
            const receipt = (await computeResultCaptureReceipt(result, identity))!;
            expect(runtime.state().commandHistory.length).toBeGreaterThan(0);
            const release = { kind: 'results.release', protocolVersion: 1, ...identity, requestId: 'release', receipts: [receipt] };
            socket.publishMessage(JSON.stringify(release));
            await expect.poll(() => socket.sent.map((frame) => JSON.parse(frame)).some((frame) => frame.payload?.status === 'released')).toBe(true);
            expect(runtime.state().resultCache.first).toBeUndefined();
            socket.close();
            await expect.poll(() => socket.readyState).toBe(0);
            socket.open();
            socket.publishMessage(JSON.stringify({ ...release, requestId: 'duplicate' }));
            await expect.poll(() =>
                socket.sent.map((frame) => JSON.parse(frame)).some((frame) => frame.payload?.requestId === 'duplicate' && frame.payload.status === 'released')
            ).toBe(true);
            socket.publishMessage(JSON.stringify({ kind: 'command', protocolVersion: 1, ...identity, commandId: 'second', command: { kind: 'health' } }));
            await expect.poll(() =>
                socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.kind === 'report').at(-1)?.payload.payload.summary.commands
            ).toBe(2);
            const summary = socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.kind === 'report').at(-1).payload.payload.summary;
            expect(summary.retainedResults).toBe(1);
            expect(summary.releasedResults).toBe(1);
        }
        finally {
            client.dispose();
        }
    });
});
