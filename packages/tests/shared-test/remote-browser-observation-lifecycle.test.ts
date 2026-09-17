import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import type { WsInteraction } from '../../shared-test/black-box-runner/ws/ws-wait-expectations.ts';

import { runRemoteWsInteraction } from '../../shared-test/black-box-runner/execution/remote-browser-websocket-interaction.ts';
import { createRallarRemoteBrowserRtcProvider } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';
import { decodeRemoteBrowserObservations } from '../../shared-test/black-box-runner/remote-browser/decode-remote-browser-observations.ts';

function toEmptySnapshotResponse(): Response {
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

    it('reports a polling failure as the failure of the owning wait', async () => {
        vi.useFakeTimers();
        let initial = true;
        const provider = createRallarRemoteBrowserRtcProvider({
            runId: 'observation-run',
            pollIntervalMs: 5,
            fetch: async () => {
                if (initial) {
                    initial = false;
                    return toEmptySnapshotResponse();
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
        expect(await outcome).toMatchObject({
            result: { status: 'FAILURE', result: 'Remote RTC wait failed', actual: { exception: 'Control polling disconnected' } }
        });
    });

    it('reports a polling failure while a send waits for its expectation as the failure of the send', async () => {
        let reads = 0;
        const sentCommandIds: string[] = [];
        const provider = createRallarRemoteBrowserRtcProvider({
            runId: 'observation-run',
            agentId: 'agent',
            pollIntervalMs: 1,
            timeoutMs: 100,
            fetch: async (_input, init) => {
                if (init?.method === 'POST') {
                    const { commandId } = JSON.parse(String(init.body));
                    sentCommandIds.push(commandId);
                    return Response.json({ accepted: true }, { status: 202 });
                }
                reads++;
                if (reads > 2) {
                    throw new Error('Send observation polling failed');
                }
                return Response.json({
                    runId: 'observation-run',
                    results: sentCommandIds.map((commandId) => ({
                        kind: 'result',
                        protocolVersion: 1,
                        runId: 'observation-run',
                        agentId: 'agent',
                        commandId,
                        ok: true
                    })),
                    events: []
                });
            }
        });
        const interaction = {
            request: { action: 'send', connection: 'alice', send: { topic: 'sent' } },
            response: { message: { topic: 'never-arrives' }, withinMs: 20 }
        };

        const result = await provider.send(interaction, { interaction }, {
            dependencies: { now: Date.now, createUuid: () => 'unused', fetch: async () => toEmptySnapshotResponse() },
            rtcConnections: { alice: {} },
            rtcMessages: {},
            rtcCloseEvents: {}
        });

        expect(result).toMatchObject({
            status: 'FAILURE',
            result: 'Remote RTC send failed',
            actual: { exception: 'Send observation polling failed' }
        });
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
                    return toEmptySnapshotResponse();
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
            pendingRead.resolve(toEmptySnapshotResponse());
            await waiting;
        }
        expect(settled).toBe(true);
    });

    it('decodes an event carrying the messages.ws connect transport', () => {
        const decoded = decodeRemoteBrowserObservations({
            runId: 'observation-run',
            results: [],
            events: [{
                kind: 'event',
                protocolVersion: 1,
                runId: 'observation-run',
                agentId: 'agent',
                eventId: 'ws-carrier-event',
                atEpochMs: 1,
                payload: {
                    kind: 'message',
                    eventId: 'ws-carrier-event',
                    topic: 'rallar.browser.messages.ws.message',
                    connection: 'alice',
                    atEpochMs: 1,
                    transport: 'messages.ws'
                }
            }]
        }, 'observation-run');

        expect(decoded.right?.events[0].payload.transport).toBe('messages.ws');
    });

    it('decodes only the declared members of an event projection', () => {
        const projection = {
            kind: 'message',
            eventId: 'declared-event',
            topic: 'rallar.browser.rtc.message',
            atEpochMs: 1,
            commandId: 'command',
            connection: 'alice',
            actor: 'alice',
            transport: 'realtime',
            severity: 'info',
            payload: { data: { text: 'hello' } }
        };
        const decoded = decodeRemoteBrowserObservations({
            runId: 'observation-run',
            results: [],
            events: [{
                kind: 'event',
                protocolVersion: 1,
                runId: 'observation-run',
                agentId: 'agent',
                eventId: 'declared-event',
                atEpochMs: 1,
                payload: { ...projection, undeclared: 'dropped' }
            }]
        }, 'observation-run');

        expect(decoded.right?.events[0].payload).toEqual(projection);
    });
});

function toForbiddenSnapshotResponse(transport: 'RTC' | 'WS'): Response {
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
                fetch: async () => ++reads === 1 ? toEmptySnapshotResponse() : pendingRead.promise
            };
            const context = {
                dependencies: { now: Date.now, createUuid: () => 'unused', fetch: options.fetch },
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
                : runRemoteWsInteraction(interaction, { interaction }, context))
                .then((result) => ({ result }), (error) => ({ error }))
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
                    outcome === 'empty' ? toEmptySnapshotResponse() : toForbiddenSnapshotResponse(transport)
                );
            }
            const result = await waiting;
            expect(settledBeforeRead).toBe(false);
            expect(reads).toBe(2);
            if (outcome === 'failure') {
                expect(result).toMatchObject({ result: { status: 'FAILURE', actual: { exception: 'Owned observation failed' } } });
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
