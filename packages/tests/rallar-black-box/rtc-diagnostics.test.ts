import { describe, expect, it } from 'vitest';
import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
} from '../../shared-test/rallar-bb-test/types.ts';
import {
    deriveRtcDiagnostics,
    deriveRtcPerformanceView,
    deriveRtcDiagnosticsTimeseries,
    rtcConnectStageIdForEvent,
} from '../../../apps/rallar-black-box/src/rtc-diagnostics.ts';
import type { DistributedRunMonitor } from '../../../apps/rallar-black-box/src/distributed-recipes.ts';

function event(
    eventId: string,
    topic: string,
    atEpochMs: number,
    payload: Record<string, unknown> = {},
): RallarBlackBoxTestEvent {
    return {
        eventId,
        kind: 'diagnostic',
        topic,
        atEpochMs,
        connection: 'aliceRtc',
        actor: 'alice',
        transport: 'realtime',
        severity: 'info',
        payload,
    };
}

function result(
    commandId: string,
    kind: RallarBlackBoxTestResult['kind'],
    startedAtEpochMs: number,
    durationMs: number,
): RallarBlackBoxTestResult {
    return {
        commandId,
        kind,
        status: 'ok',
        ok: true,
        startedAtEpochMs,
        endedAtEpochMs: startedAtEpochMs + durationMs,
        durationMs,
    };
}

function state(
    events: readonly RallarBlackBoxTestEvent[],
    commandHistory: readonly RallarBlackBoxTestResult[] = [],
): RallarBlackBoxTestState {
    return {
        status: 'completed',
        currentConfig: {
            runId: 'run-1',
            agentId: 'agent-1',
            actor: 'alice',
            sessionId: 'alice-session',
            roomId: 'room-1',
            transport: 'realtime',
            apiBaseUrl: 'https://api.example.test',
            control: {
                providerMode: 'browser-rallar',
            },
            rallar: {
                username: 'alice',
                password: '<redacted>',
                restoreSession: true,
                logoutOnClose: true,
                leaveRoomOnClose: true,
            },
            defaults: {
                connection: 'aliceRtc',
            },
        },
        commandHistory,
        events,
        failures: [],
        resultCache: Object.fromEntries(commandHistory.map(entry => [entry.commandId, entry])),
        latestStats: {
            atEpochMs: 200,
            status: 'completed',
            counters: {
                commands: commandHistory.length,
                events: events.length,
                failures: 0,
                messages: events.filter(entry => entry.kind === 'message').length,
                diagnostics: events.filter(entry => entry.kind === 'diagnostic').length,
            },
            commandLatency: {
                count: commandHistory.length,
                lastMs: commandHistory.at(-1)?.durationMs,
                averageMs: 25,
                maxMs: 70,
            },
        },
    };
}

describe('rallar-black-box RTC diagnostics', () => {
    it('maps runtime topics and phases to connect stages', () => {
        expect(rtcConnectStageIdForEvent(event('event-1', 'rallar.browser.auth.completed', 10)))
            .toBe('auth');
        expect(rtcConnectStageIdForEvent(event('event-2', 'rallar.browser.connect.phase_failed', 11, {
            phase: 'peer-discovery',
        }))).toBe('peer-discovery');
        expect(rtcConnectStageIdForEvent({
            ...event('event-3', 'rallar.browser.messages.rtc.message', 12),
            kind: 'message',
        })).toBe('first-payload');
    });

    it('derives timeline, membership, latency, and bundle data from runtime events', () => {
        const events: RallarBlackBoxTestEvent[] = [
            event('event-auth', 'rallar.browser.auth.completed', 100, { phase: 'auth' }),
            event('event-runtime', 'rallar.browser.runtime.bootstrap_completed', 120),
            event('event-group', 'rallar.browser.room.joined', 140, {
                roomId: 'room-1',
                sessionId: 'alice-session',
                expectedClients: ['alice-session', 'bob-session'],
                observedClients: ['alice-session'],
                peerCount: 1,
                laneHealth: 'opening',
            }),
            event('event-signal', 'rallar.browser.signaling.ready', 150),
            event('event-peer', 'rallar.browser.peer.discovered', 160, {
                peerId: 'bob-session',
            }),
            event('event-channel', 'rallar.browser.data_channel.ready', 170, {
                laneHealth: 'open',
                readyPeerIds: ['alice-session', 'bob-session'],
                activePeerIds: ['alice-session', 'bob-session'],
            }),
            {
                eventId: 'event-message',
                kind: 'message',
                topic: 'rallar.browser.realtime.message',
                atEpochMs: 190,
                commandId: 'send-1',
                connection: 'aliceRtc',
                actor: 'alice',
                transport: 'realtime',
                severity: 'info',
                payload: {
                    senderId: 'bob-session',
                    data: {
                        topic: 'manual.ping',
                        text: 'pong',
                    },
                },
            },
        ];
        const diagnostics = deriveRtcDiagnostics(state(events, [
            result('connect-1', 'rtc.connect', 90, 85),
            result('send-1', 'rtc.send', 180, 12),
        ]));

        expect(diagnostics.stages.map(stage => [stage.stageId, stage.status])).toEqual([
            ['auth', 'observed'],
            ['runtime-bootstrap', 'observed'],
            ['group-join', 'observed'],
            ['signaling', 'observed'],
            ['peer-discovery', 'observed'],
            ['data-channel', 'observed'],
            ['first-payload', 'observed'],
        ]);
        expect(diagnostics.membership).toMatchObject({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            sessionId: 'alice-session',
            expectedClients: ['alice-session', 'bob-session'],
            observedClients: ['alice-session', 'bob-session'],
            readyPeerIds: ['alice-session', 'bob-session'],
            activePeerIds: ['alice-session', 'bob-session'],
            missingClients: [],
            staleClients: [],
        });
        expect(diagnostics.latency).toMatchObject({
            connectMs: 85,
            firstPayloadMs: 10,
            firstPayloadFromConnectMs: 100,
            lastCommandMs: 12,
            averageCommandMs: 25,
            maxCommandMs: 70,
        });
        expect(diagnostics.bundle).toMatchObject({
            runId: 'run-1',
            agentId: 'agent-1',
            status: 'completed',
            config: {
                providerMode: 'browser-rallar',
                environment: undefined,
                apiBaseUrl: 'https://api.example.test',
                auth: {
                    hasUsername: true,
                    hasPassword: true,
                    restoreSession: true,
                    logoutOnClose: true,
                    leaveRoomOnClose: true,
                },
            },
            commandIds: ['connect-1', 'send-1'],
        });
    });

    it('surfaces failed connect stages and missing expected clients', () => {
        const failure = {
            ...event('event-failure', 'rallar.browser.connect.phase_failed', 150, {
                phase: 'data-channel',
                error: {
                    message: 'channel timeout',
                },
                expectedClients: ['bob-session'],
            }),
            severity: 'error',
        } satisfies RallarBlackBoxTestEvent;
        const diagnostics = deriveRtcDiagnostics(state([failure], [
            {
                ...result('connect-1', 'rtc.connect', 100, 50),
                status: 'failed',
                ok: false,
                error: {
                    code: 'RTC_TIMEOUT',
                    message: 'channel timeout',
                },
            },
        ]));

        expect(diagnostics.stages.find(stage => stage.stageId === 'data-channel')).toMatchObject({
            status: 'failed',
            topic: 'rallar.browser.connect.phase_failed',
        });
        expect(diagnostics.failure).toMatchObject({
            stageId: 'data-channel',
            source: 'rallar-runtime',
            message: 'channel timeout',
        });
        expect(diagnostics.membership.missingClients).toEqual(['bob-session']);
    });

    it('surfaces ready peers, active peers, lane health, and NACK evidence', () => {
        const diagnostics = deriveRtcDiagnostics(state([
            event('event-send', 'rallar.bb.fake.rtc.send_completed', 130, {
                expectedClients: ['bob-session', 'charlie-session'],
                readyPeerIds: ['bob-session'],
                activePeerIds: ['bob-session'],
                laneHealth: 'degraded',
                peerCount: 1,
            }),
            {
                ...event('event-nack', 'rallar.bb.fake.rtc.not-yet-in-sync', 140, {
                    negativeCase: 'not-yet-in-sync',
                    nack: {
                        code: 'not-yet-in-sync',
                        message: 'Snapshot is behind the minimum requested version.',
                    },
                    expectedClients: ['bob-session', 'charlie-session'],
                    observedClients: ['bob-session'],
                }),
                severity: 'warning',
            },
        ], [
            result('send-1', 'rtc.send', 120, 20),
        ]));

        expect(diagnostics.membership).toMatchObject({
            readyPeerIds: ['bob-session'],
            activePeerIds: ['bob-session'],
            missingClients: ['charlie-session'],
            nackCodes: ['not-yet-in-sync'],
            peerCount: 1,
            laneHealth: 'degraded',
        });
        expect(diagnostics.failure).toMatchObject({
            source: 'rallar-runtime',
            message: 'Snapshot is behind the minimum requested version.',
        });
    });

    it('derives RTC time-series buckets for events, messages, failures, and phase durations', () => {
        const sampleState = state([
            event('event-phase-1', 'rallar.direct.rtc_realtime.phase', 1_000, {
                phase: 'start',
                durationMs: 10,
            }),
            {
                ...event('event-message', 'rallar.direct.rtc_realtime.message', 2_000),
                kind: 'message',
            },
            {
                ...event('event-ws-message', 'rallar.direct.ws.message', 2_000),
                kind: 'message',
                transport: 'ws',
            },
            {
                ...event('event-failed', 'rallar.direct.rtc_realtime.phase', 3_000, {
                    phase: 'send',
                    durationMs: 30,
                    error: 'failed',
                }),
                severity: 'error',
            },
        ]);
        const diagnostics = deriveRtcDiagnostics(sampleState);
        const series = deriveRtcDiagnosticsTimeseries(
            sampleState,
            { bucketCount: 4, bucketMs: 1_000, endAtEpochMs: 3_000 },
        );

        expect(diagnostics.timeseries.map(entry => entry.seriesId)).toEqual([
            'events',
            'messages',
            'failures',
            'phase-duration',
        ]);
        expect(series.find(entry => entry.seriesId === 'events')?.points.map(point => point.value))
            .toEqual([0, 1, 1, 1]);
        expect(series.find(entry => entry.seriesId === 'messages')?.points.map(point => point.value))
            .toEqual([0, 0, 1, 0]);
        expect(series.find(entry => entry.seriesId === 'failures')?.points.map(point => point.value))
            .toEqual([0, 0, 0, 1]);
        expect(series.find(entry => entry.seriesId === 'phase-duration')?.points.map(point => point.value))
            .toEqual([0, 10, 0, 30]);
    });

    it('derives scatter, distribution, waterfall, and lane matrix performance views', () => {
        const sampleState = state([
            event('event-auth', 'rallar.browser.auth.completed', 100, { phase: 'auth' }),
            event('event-runtime', 'rallar.browser.runtime.bootstrap_completed', 120),
            event('event-group', 'rallar.browser.room.joined', 140, {
                roomId: 'room-1',
                sessionId: 'alice-session',
                expectedClients: ['alice-session', 'bob-session'],
                observedClients: ['alice-session', 'bob-session'],
            }),
            event('event-signal', 'rallar.browser.signaling.ready', 150),
            event('event-peer', 'rallar.browser.peer.discovered', 160, {
                peerId: 'bob-session',
            }),
            event('event-channel', 'rallar.browser.data_channel.ready', 170, {
                readyPeerIds: ['alice-session', 'bob-session'],
                activePeerIds: ['alice-session'],
                durationMs: 18,
            }),
            {
                ...event('event-message', 'rallar.browser.realtime.message', 205),
                kind: 'message',
            },
        ], [
            result('connect-1', 'rtc.connect', 90, 85),
            result('send-1', 'rtc.send', 180, 12),
            result('ws-1', 'ws.send', 210, 34),
        ]);
        const diagnostics = deriveRtcDiagnostics(sampleState);
        const performance = deriveRtcPerformanceView({
            diagnostics,
            state: sampleState,
            histogramBucketCount: 3,
        });

        expect(performance.summary).toMatchObject({
            commandCount: 3,
            p50Ms: 34,
            p95Ms: 85,
            maxMs: 85,
            failureCount: 0,
        });
        expect(performance.scatter.map(point => [point.commandId, point.transport, point.durationMs])).toEqual([
            ['connect-1', 'rtc', 85],
            ['send-1', 'rtc', 12],
            ['ws-1', 'ws', 34],
        ]);
        expect(performance.histogram.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
        expect(performance.phaseSpans.map(span => [span.stageId, span.status, span.endMs])).toContainEqual([
            'first-payload',
            'observed',
            115,
        ]);
        expect(performance.phaseSpans.find(span => span.stageId === 'data-channel')).toMatchObject({
            durationMs: 18,
            timingKind: 'duration',
            valueLabel: '18 ms duration',
        });
        expect(performance.phaseSpans.find(span => span.stageId === 'first-payload')).toMatchObject({
            timingKind: 'observed-delta',
            valueLabel: '115 ms observed delta',
        });
        expect(performance.agentMatrix.map(cell => [cell.laneId, cell.metric, cell.status])).toContainEqual([
            'bob-session',
            'active',
            'warn',
        ]);
        expect(performance.timeseries.map(series => series.seriesId)).toEqual([
            'events',
            'messages',
            'failures',
            'phase-duration',
        ]);
    });

    it('adds distributed monitor agent timing to RTC performance views', () => {
        const sampleState = state([
            event('event-runtime', 'rallar.browser.runtime.bootstrap_completed', 120),
        ], [
            result('send-1', 'rtc.send', 180, 12),
        ]);
        const distributedMonitor = {
            agentProgress: [
                {
                    agentId: 'agent-a',
                    role: 'sender',
                    readiness: 'passed',
                    barrier: 'passed',
                    execution: 'passed',
                    stageCommandCount: 1,
                    barrierCommandCount: 1,
                    startCommandCount: 1,
                    completedCommandCount: 3,
                    failedCommandCount: 0,
                    resultCount: 3,
                    eventCount: 4,
                    averageLatencyMs: 42,
                    lastActivityAtEpochMs: 240,
                },
                {
                    agentId: 'agent-b',
                    role: 'receiver',
                    readiness: 'passed',
                    barrier: 'passed',
                    execution: 'failed',
                    stageCommandCount: 1,
                    barrierCommandCount: 1,
                    startCommandCount: 1,
                    completedCommandCount: 2,
                    failedCommandCount: 1,
                    resultCount: 3,
                    eventCount: 1,
                    averageLatencyMs: 220,
                    lastActivityAtEpochMs: 260,
                },
            ],
        } as unknown as DistributedRunMonitor;
        const performance = deriveRtcPerformanceView({
            diagnostics: deriveRtcDiagnostics(sampleState),
            state: sampleState,
            distributedMonitor,
            histogramBucketCount: 4,
        });

        expect(performance.summary.commandCount).toBe(3);
        expect(performance.scatter.map(point => [point.commandId, point.source, point.agentId, point.durationMs])).toEqual([
            ['send-1', 'local-result', 'agent-1', 12],
            ['agent-a', 'distributed-agent', 'agent-a', 42],
            ['agent-b', 'distributed-agent', 'agent-b', 220],
        ]);
        expect(performance.agentMatrix.map(cell => [cell.laneId, cell.metric, cell.value, cell.status])).toEqual(expect.arrayContaining([
            ['agent-b', 'expected', 'yes', 'good'],
            ['agent-b', 'active', 'no', 'warn'],
            ['agent-b', 'missing', 'no', 'good'],
        ]));
        expect(performance.histogram.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
    });

    it('returns explicit empty RTC performance states', () => {
        const emptyState = state([]);
        const performance = deriveRtcPerformanceView({
            diagnostics: deriveRtcDiagnostics(emptyState),
            state: emptyState,
        });

        expect(performance.summary.commandCount).toBe(0);
        expect(performance.emptyReasons).toEqual([
            'No RTC/WS command results yet',
            'No RTC timeline events yet',
        ]);
        expect(performance.scatter).toEqual([]);
        expect(performance.histogram).toEqual([]);
        expect(performance.phaseSpans).toEqual([]);
    });

    it('classifies control, provider config, auth, permission, and cleanup failures', () => {
        const cases = [
            ['rallar.bb.control.protocol_error', 'control'],
            ['rallar.bb.provider.browser_rallar.config_invalid', 'provider-config'],
            ['rallar.browser.auth.login_failed', 'rallar-auth'],
            ['rallar.browser.connect.phase_failed', 'rallar-permission'],
            ['rallar.browser.cleanup.room_leave_failed', 'rallar-cleanup'],
        ] as const;

        for (const [topic, source] of cases) {
            const diagnostics = deriveRtcDiagnostics(state([
                {
                    ...event('event-failure', topic, 150, {
                        phase: topic.includes('phase_failed') ? 'room-join' : undefined,
                        error: {
                            message: 'failure',
                        },
                    }),
                    severity: 'error',
                },
            ]));

            expect(diagnostics.failure).toMatchObject({
                source,
                message: 'failure',
            });
        }
    });
});
