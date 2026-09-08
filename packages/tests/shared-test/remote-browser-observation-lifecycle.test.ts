import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import type { WsInteraction } from '../../shared-test/black-box-runner/ws/ws-wait-expectations.ts';

import { executeRemoteWsInteraction } from '../../shared-test/black-box-runner/execution/remote-browser-websocket-interaction.ts';
import { createRallarRemoteBrowserRtcProvider } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';

function emptySnapshot(): Response {
    return Response.json({ runId: 'observation-run', results: [], events: [] });
}

function waitInteraction(): WsInteraction {
    return {
        request: { connection: 'alice', timeoutMs: 10 },
        response: { message: { topic: 'expected' } }
    };
}

describe('remote-browser observation lifecycle', () => {
    afterEach(() => vi.useRealTimers());

    it('surfaces a polling failure through the owning wait', async () => {
        vi.useFakeTimers();
        let initial = true;
        const provider = createRallarRemoteBrowserRtcProvider({
            runId: 'observation-run',
            pollIntervalMs: 5,
            fetch: async () => {
                if (initial) {
                    initial = false;
                    return emptySnapshot();
                }
                throw new Error('Control polling disconnected');
            }
        });

        const waiting = provider.wait(waitInteraction(), { interaction: { request: {} } }, {
            dependencies: { now: Date.now, createUuid: () => crypto.randomUUID() },
            rtcMessages: {}
        });
        const outcome = waiting.then((result) => ({ result }), (error) => ({ error }));
        await vi.advanceTimersByTimeAsync(100);
        expect(await outcome).toEqual({ error: new Error('Control polling disconnected') });
    });

    it('finishes in-flight observation work before returning from the wait', async () => {
        vi.useFakeTimers();
        const pendingRead = Promise.withResolvers<Response>();
        let initial = true;
        const provider = createRallarRemoteBrowserRtcProvider({
            runId: 'observation-run',
            pollIntervalMs: 5,
            fetch: async () => {
                if (initial) {
                    initial = false;
                    return emptySnapshot();
                }
                return pendingRead.promise;
            }
        });
        let settled = false;
        const waiting = provider.wait(waitInteraction(), { interaction: { request: {} } }, {
            dependencies: { now: Date.now, createUuid: () => crypto.randomUUID() },
            rtcMessages: {}
        })
            .finally(() => {
                settled = true;
            });

        try {
            await vi.advanceTimersByTimeAsync(100);
            expect(settled).toBe(false);
        }
        finally {
            pendingRead.resolve(emptySnapshot());
            await waiting;
        }
        expect(settled).toBe(true);
    });
});

function forbiddenSnapshot(transport: 'RTC' | 'WS'): Response {
    return Response.json({
        runId: 'observation-run',
        results: [],
        events: [{
            kind: 'event',
            protocolVersion: 1,
            runId: 'observation-run',
            agentId: 'agent',
            eventId: 'forbidden-event',
            atEpochMs: 1,
            payload: {
                kind: 'message',
                eventId: 'forbidden-event',
                topic: 'forbidden',
                connection: 'alice',
                atEpochMs: 1,
                transport: transport === 'WS' ? 'ws' : 'realtime',
                payload: { data: { topic: 'forbidden' } }
            }
        }]
    });
}

for (
    const { transport, expectation } of [
        { transport: 'RTC', expectation: 'count' },
        { transport: 'WS', expectation: 'count' },
        { transport: 'WS', expectation: 'absence' }
    ] as const
) {
    for (const outcome of ['message', 'failure', 'empty'] as const) {
        it(`${transport} ${expectation} includes its pending ${outcome} observation before the verdict`, async () => {
            vi.useFakeTimers();
            const pendingRead = Promise.withResolvers<Response>();
            let reads = 0;
            const options = {
                runId: 'observation-run',
                agentId: 'agent',
                pollIntervalMs: 1,
                fetch: async () => ++reads === 1 ? emptySnapshot() : pendingRead.promise
            };
            const context = {
                dependencies: { now: Date.now, createUuid: () => 'unused' },
                options: { rallarRemoteBrowser: options },
                rtcMessages: {},
                wsMessages: {},
                wsConnections: {},
                wsCloseEvents: {}
            };
            const interaction = {
                request: { action: 'wait', connection: 'alice' },
                response: expectation === 'count'
                    ? { message: { topic: 'forbidden' }, count: 0, withinMs: 10 }
                    : { absent: { topic: 'forbidden' }, withinMs: 10 }
            };
            let settled = false;
            const waiting = (transport === 'RTC'
                ? createRallarRemoteBrowserRtcProvider(options).wait(interaction, { interaction }, context)
                : executeRemoteWsInteraction(interaction, { interaction }, context))
                .then((result) => ({ result }), (error: unknown) => ({ error }))
                .finally(() => {
                    settled = true;
                });
            await vi.advanceTimersByTimeAsync(30);
            const settledBeforeRead = settled;
            if (outcome === 'failure') {
                pendingRead.reject(new Error('Owned observation failed'));
            }
            else {
                pendingRead.resolve(
                    outcome === 'empty' ? emptySnapshot() : forbiddenSnapshot(transport)
                );
            }
            const result = await waiting;
            expect(settledBeforeRead).toBe(false);
            expect(reads).toBe(2);
            if (outcome === 'failure') {
                if (transport === 'RTC') {
                    expect(result).toEqual({ error: new Error('Owned observation failed') });
                }
                else {
                    expect(result).toMatchObject({ result: { status: 'FAILURE', actual: { exception: 'Owned observation failed' } } });
                }
            }
            else {
                expect(result).toMatchObject({
                    result: {
                        status: outcome === 'empty' ? 'SUCCESS' : 'FAILURE',
                        ...(expectation === 'count' ? { actual: { matchedCount: outcome === 'empty' ? 0 : 1 } } : {})
                    }
                });
            }
        });
    }
}
