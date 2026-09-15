import * as timers from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxBrowserTestRuntime,
    selectRallarBlackBoxDiagnostics,
    selectRallarBlackBoxEvents,
    selectRallarBlackBoxMessages,
    type RallarBlackBoxBrowserRallarConnectionConfig,
    type RallarBlackBoxBrowserRallarRuntime,
    type RallarBlackBoxBrowserRallarRuntimeMethod,
    type RallarBlackBoxTestRtcStreamResultValue
} from '../../../shared-test/rallar-bb-test/mod.ts';
import { createBrowserRallarRequiredMethodsTestDouble } from '.././browser-rallar-required-methods-test-double.ts';

type AdapterMethodInput =
    | Parameters<RallarBlackBoxBrowserRallarRuntimeMethod>[0]
    | Parameters<RallarBlackBoxBrowserRallarRuntime['send']>[0];

interface RecordedAdapterCall {
    readonly name: string;
    /** Absent for adapter calls that take no input. */
    readonly value?: AdapterMethodInput | RallarBlackBoxBrowserRallarConnectionConfig;
}

interface RecordedFetchCall {
    readonly input: RequestInfo | URL;
    readonly init: RequestInit | undefined;
}

describe('rallar-bb runtime capabilities', () => {
    it('delegates RTC commands to the browser Rallar runtime adapter', async () => {
        const calls: RecordedAdapterCall[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            now: (() => {
                let now = 2_000;
                return () => now++;
            })(),
            idFactory: (() => {
                let sequence = 1;
                return (prefix: string) => `${prefix}-${sequence++}`;
            })(),
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async (config) => {
                    calls.push({ name: 'connect', value: config });
                    return {
                        connected: true,
                        sessionId: 'session-1'
                    };
                },
                send: async (input) => {
                    calls.push({ name: 'send', value: input });
                    return {
                        sent: true
                    };
                },
                refreshRoom: async () => undefined,
                close: async () => {
                    calls.push({ name: 'close' });
                    return {
                        closed: true
                    };
                },
                health: async () => {
                    calls.push({ name: 'health' });
                    return {
                        connected: true
                    };
                }
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-browser',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                roomId: 'room-1',
                transport: 'messages.rtc',
                rallar: {
                    typeId: 'chat.message'
                }
            }
        });
        const connectResult = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-browser',
            connection: 'aliceRtc'
        });
        const sendResult = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'send-browser',
            connection: 'aliceRtc',
            send: {
                payload: {
                    text: 'hello'
                }
            }
        });
        runtime.receiveRallarBrowserEvent({
            kind: 'message',
            topic: 'rallar.browser.messages.rtc.message',
            connection: 'aliceRtc',
            actor: 'alice',
            transport: 'messages.rtc',
            data: {
                password: 'secret',
                text: 'from browser'
            }
        });
        const healthResult = await runtime.execute({
            kind: 'health',
            commandId: 'health-browser'
        });
        const closeResult = await runtime.execute({
            kind: 'close',
            commandId: 'close-browser'
        });

        expect(connectResult.ok).toBe(true);
        expect(sendResult.ok).toBe(true);
        expect(healthResult.ok).toBe(true);
        expect(closeResult.ok).toBe(true);
        expect(calls.map((call) => call.name)).toEqual([
            'connect',
            'send',
            'health',
            'close'
        ]);
        expect(calls[0].value).toEqual({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                typeId: 'chat.message',
                transport: 'messages.rtc'
            }
        });
        expect(calls[1].value).toEqual({
            payload: {
                text: 'hello'
            }
        });
        expect(selectRallarBlackBoxMessages(runtime.state())[0].payload).toEqual({
            roomId: undefined,
            laneId: undefined,
            peerId: undefined,
            remotePeerId: undefined,
            senderId: undefined,
            typeId: undefined,
            topicId: undefined,
            contextId: undefined,
            resourceId: undefined,
            data: {
                password: '<redacted>',
                text: 'from browser'
            },
            error: undefined
        });
    });

    it('delegates CRDT commands to the browser Rallar runtime adapter', async () => {
        const calls: RecordedAdapterCall[] = [];
        const recordCrdtCall = (name: string) => async (input: AdapterMethodInput) => {
            calls.push({ name, value: input });
            return {
                status: name,
                handle: input !== null && typeof input === 'object' ? Reflect.get(input, 'handle') : undefined,
                health: {
                    pendingUpdateCount: 0
                }
            };
        };
        const crdt = {
            open: recordCrdtCall('open'),
            apply: recordCrdtCall('apply'),
            read: recordCrdtCall('read'),
            sync: recordCrdtCall('sync'),
            health: recordCrdtCall('health'),
            wait: recordCrdtCall('wait'),
            undo: recordCrdtCall('undo'),
            redo: recordCrdtCall('redo'),
            close: recordCrdtCall('close'),
            destroy: recordCrdtCall('destroy')
        };
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true }),
                crdt
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-crdt',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                roomId: 'room-1',
                rallar: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default'
                }
            }
        });
        await runtime.execute({
            kind: 'crdt.open',
            commandId: 'open-crdt',
            handle: 'doc',
            name: 'checklist',
            transport: 'ws',
            durableCatchUp: 'http'
        });
        await runtime.execute({
            kind: 'crdt.apply',
            commandId: 'apply-crdt',
            handle: 'doc',
            batch: {
                kind: 'batch',
                operations: [
                    {
                        kind: 'counter.add',
                        path: ['count'],
                        delta: 1
                    }
                ]
            }
        });
        await runtime.execute({ kind: 'crdt.read', commandId: 'read-crdt', handle: 'doc' });
        await runtime.execute({ kind: 'crdt.sync', commandId: 'sync-crdt', handle: 'doc', transport: 'ws' });
        await runtime.execute({ kind: 'crdt.health', commandId: 'health-crdt', handle: 'doc' });
        await runtime.execute({
            kind: 'crdt.wait',
            commandId: 'wait-crdt',
            handle: 'doc',
            timeoutMs: 1_000,
            intervalMs: 50,
            sync: {
                reason: 'unit-test',
                transport: 'ws'
            },
            conditions: [
                {
                    source: 'value',
                    path: 'title',
                    operator: 'equals',
                    expected: 'Ready'
                },
                {
                    source: 'health',
                    path: 'pendingUpdateCount',
                    operator: 'equals',
                    expected: 0
                }
            ]
        });
        await runtime.execute({
            kind: 'crdt.undo',
            commandId: 'undo-crdt',
            handle: 'doc',
            targetOperationGroupId: 'group-1',
            operations: [
                {
                    kind: 'counter.add',
                    path: ['count'],
                    delta: -1
                }
            ]
        });
        await runtime.execute({
            kind: 'crdt.redo',
            commandId: 'redo-crdt',
            handle: 'doc',
            targetOperationGroupId: 'group-1',
            operations: [
                {
                    kind: 'counter.add',
                    path: ['count'],
                    delta: 1
                }
            ]
        });
        await runtime.execute({ kind: 'crdt.close', commandId: 'close-crdt', handle: 'doc' });
        await runtime.execute({ kind: 'crdt.destroy', commandId: 'destroy-crdt', handle: 'doc' });

        expect(calls.map((call) => call.name)).toEqual([
            'open',
            'apply',
            'read',
            'sync',
            'health',
            'wait',
            'undo',
            'redo',
            'close',
            'destroy'
        ]);
        expect(calls[0].value).toMatchObject({
            handle: 'doc',
            name: 'checklist',
            apiBaseUrl: 'https://api.example.test',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                applicationId: 'rallar-server',
                workspaceId: 'default'
            }
        });
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic)).toEqual(expect.arrayContaining([
            'rallar.bb.crdt.opened',
            'rallar.bb.crdt.applied',
            'rallar.bb.crdt.read',
            'rallar.bb.crdt.synced',
            'rallar.bb.crdt.health',
            'rallar.bb.crdt.waiting',
            'rallar.bb.crdt.wait_matched',
            'rallar.bb.crdt.undone',
            'rallar.bb.crdt.redone',
            'rallar.bb.crdt.closed',
            'rallar.bb.crdt.destroyed'
        ]));
    });

    it('delegates director commands to the browser Rallar runtime adapter', async () => {
        const calls: RecordedAdapterCall[] = [];
        const recordDirectorCall = (name: string) => async (input: AdapterMethodInput) => {
            calls.push({ name, value: input });
            return {
                status: name,
                handle: input !== null && typeof input === 'object' ? Reflect.get(input, 'handle') : undefined,
                role: name === 'appoint' || name === 'relayStart' ? 'director' : 'client',
                state: 'fresh'
            };
        };
        const director = {
            appoint: recordDirectorCall('appoint'),
            resign: recordDirectorCall('resign'),
            status: recordDirectorCall('status'),
            relayStart: recordDirectorCall('relayStart'),
            intent: recordDirectorCall('intent'),
            syncRequest: recordDirectorCall('syncRequest'),
            relayStop: recordDirectorCall('relayStop')
        };
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true }),
                director
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-director',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                roomId: 'room-1',
                rallar: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default'
                },
                defaults: {
                    groupId: 'room-1'
                }
            }
        });
        await runtime.execute({
            kind: 'director.appoint',
            commandId: 'appoint-director',
            heartbeatTtlMs: 1_200
        });
        await runtime.execute({
            kind: 'director.status',
            commandId: 'status-director',
            refresh: true
        });
        await runtime.execute({
            kind: 'director.relay.start',
            commandId: 'start-director',
            handle: 'relay-1',
            topicId: 'app.test.director',
            intentTypeId: 'app.test.director.intent',
            outputTypeId: 'app.test.director.output',
            heartbeatIntervalMs: 300,
            snapshotIntervalMs: 500
        });
        await runtime.execute({
            kind: 'director.intent',
            commandId: 'intent-director',
            handle: 'relay-1',
            intent: {
                intentId: 'intent-1'
            }
        });
        await runtime.execute({
            kind: 'director.sync.request',
            commandId: 'sync-director',
            handle: 'relay-1',
            payload: {
                reason: 'unit-test'
            }
        });
        await runtime.execute({
            kind: 'director.relay.stop',
            commandId: 'stop-director',
            handle: 'relay-1'
        });
        await runtime.execute({
            kind: 'director.resign',
            commandId: 'resign-director'
        });

        expect(calls.map((call) => call.name)).toEqual([
            'appoint',
            'status',
            'relayStart',
            'intent',
            'syncRequest',
            'relayStop',
            'resign'
        ]);
        expect(calls[0].value).toMatchObject({
            roomId: 'room-1',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            heartbeatTtlMs: 1_200
        });
        expect(calls[2].value).toMatchObject({
            handle: 'relay-1',
            topicId: 'app.test.director',
            intentTypeId: 'app.test.director.intent',
            outputTypeId: 'app.test.director.output'
        });
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic)).toEqual(expect.arrayContaining([
            'rallar.bb.director.appointed',
            'rallar.bb.director.status',
            'rallar.bb.director.relay_started',
            'rallar.bb.director.intent_sent',
            'rallar.bb.director.sync_requested',
            'rallar.bb.director.relay_stopped',
            'rallar.bb.director.resigned'
        ]));
    });

    it('reports unsupported CRDT browser runtimes clearly', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'crdt.read',
            commandId: 'read-crdt-unsupported',
            handle: 'missing'
        });

        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('does not support CRDT commands');
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic)).toContain(
            'rallar.bb.crdt.failed'
        );
    });

    it('reports unsupported director browser runtimes clearly', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'director.status',
            commandId: 'director-status-unsupported',
            roomId: 'room-1'
        });

        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('does not support director commands');
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic)).toContain(
            'rallar.bb.director.failed'
        );
    });

    it('honors local browser command delays before live adapter execution', async () => {
        const sendCallEpochMs: number[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => {
                    sendCallEpochMs.push(Date.now());
                    return { sent: true };
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const startedAtEpochMs = Date.now();
        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'delayed-send',
            metadata: {
                localDelayMs: 25
            },
            send: {
                data: {
                    text: 'delayed'
                }
            }
        });

        expect(result.ok).toBe(true);
        expect(sendCallEpochMs[0] - startedAtEpochMs).toBeGreaterThanOrEqual(20);
    });

    it('executes rtc.stream sends without sequentially blocking frame scheduling', async () => {
        const sendStarts: number[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async (input) => {
                    sendStarts.push(Date.now());
                    await timers.setTimeout(80);
                    return {
                        status: 'sent',
                        input
                    };
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.stream',
            commandId: 'stream-position',
            connection: 'rtc',
            transport: 'realtime',
            count: 5,
            intervalMs: 5,
            maxInFlight: 64,
            drainTimeoutMs: 500,
            send: {
                data: {
                    seq: '{stream.index}',
                    frame: '{stream.iteration}'
                }
            }
        });
        const value = result.value as RallarBlackBoxTestRtcStreamResultValue;
        const topics = selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic);

        expect(result.ok).toBe(true);
        expect(sendStarts).toHaveLength(5);
        expect(Math.max(...sendStarts) - Math.min(...sendStarts)).toBeLessThan(200);
        expect(value).toMatchObject({
            commandId: 'stream-position',
            plannedFrames: 5,
            scheduledFrames: 5,
            attemptedFrames: 5,
            completedFrames: 5,
            failedFrames: 0,
            droppedFrames: 0
        });
        expect(value.duration.p95Ms).toBeGreaterThanOrEqual(70);
        expect(topics).toEqual(expect.arrayContaining([
            'rallar.bb.rtc.stream_started',
            'rallar.bb.rtc.stream_completed'
        ]));
    });

    it('fails rtc.stream when max in-flight saturation violates thresholds', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => {
                    await timers.setTimeout(60);
                    return {
                        status: 'sent'
                    };
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.stream',
            commandId: 'stream-saturated',
            count: 5,
            intervalMs: 1,
            maxInFlight: 1,
            drainTimeoutMs: 500,
            send: {
                data: {
                    seq: '{stream.index}'
                }
            },
            thresholds: {
                maxDroppedFrames: 0
            }
        });
        const value = result.value as RallarBlackBoxTestRtcStreamResultValue;
        const diagnostic = selectRallarBlackBoxDiagnostics(runtime.state())
            .find((event) => event.topic === 'rallar.bb.rtc.stream_failed');

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED');
        expect(value.droppedFrames).toBeGreaterThan(0);
        expect(result.error?.details).toMatchObject({
            value: {
                commandId: 'stream-saturated',
                plannedFrames: 5,
                droppedFrames: value.droppedFrames
            }
        });
        expect(value.thresholdFailures.map((failure) => failure.name)).toContain('maxDroppedFrames');
        expect(diagnostic?.payload).toMatchObject({
            diagnosticTypeId: 'rallar.bb.rtc.stream_failed',
            severity: 'error',
            commandId: 'stream-saturated'
        });
    });

    it('samples rtc.stream raw observations without changing aggregate counts', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => ({ status: 'sent' }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.stream',
            commandId: 'stream-sampled',
            count: 6,
            intervalMs: 1,
            sampleEvery: 3,
            send: {
                data: {
                    seq: '{stream.index}'
                }
            }
        });
        const value = result.value as RallarBlackBoxTestRtcStreamResultValue;

        expect(result.ok).toBe(true);
        expect(value).toMatchObject({
            plannedFrames: 6,
            scheduledFrames: 6,
            attemptedFrames: 6,
            completedFrames: 6,
            failedFrames: 0,
            droppedFrames: 0
        });
        expect(value.observations.map((observation) => observation.index)).toEqual([0, 2, 5]);
    });

    it('executes browser-native HTTP requests through the adapter', async () => {
        const fetchCalls: RecordedFetchCall[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: async (input, init) => {
                fetchCalls.push({ input, init });
                return new Response(
                    JSON.stringify({
                        received: true,
                        token: 'response-token'
                    }),
                    {
                        status: 201,
                        statusText: 'Created',
                        headers: {
                            authorization: 'Bearer response-token',
                            'content-type': 'application/json'
                        }
                    }
                );
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-http',
            config: {
                apiBaseUrl: 'https://api.example.test/root/'
            }
        });
        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-1',
            request: {
                path: 'v1/items',
                method: 'POST',
                headers: {
                    authorization: 'Bearer request-token',
                    'content-type': 'application/json'
                },
                body: {
                    name: 'item-1'
                }
            },
            response: {
                body: 'json'
            }
        });

        expect(fetchCalls).toEqual([
            {
                input: 'https://api.example.test/root/v1/items',
                init: {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer request-token',
                        'content-type': 'application/json'
                    },
                    body: '{"name":"item-1"}',
                    credentials: undefined,
                    mode: undefined,
                    signal: expect.any(AbortSignal)
                }
            }
        ]);
        expect(result.ok).toBe(true);
        expect(result.value).toEqual({
            url: 'https://api.example.test/root/v1/items',
            status: 201,
            statusText: 'Created',
            ok: true,
            headers: {
                authorization: '<redacted>',
                'content-type': 'application/json'
            },
            body: {
                received: true,
                token: '<redacted>'
            }
        });
        expect(selectRallarBlackBoxEvents(runtime.state()).some((event) => event.topic === 'rallar.bb.http.response')).toBe(true);
    });
});
