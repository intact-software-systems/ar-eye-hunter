import { describe, expect, it } from 'vitest';

import type {
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import type { DistributedRunMonitor } from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import {
    computeRtcDiagnostics,
    computeRtcDiagnosticsTimeseries,
    computeRtcPerformanceView,
    DEFAULT_RTC_PERFORMANCE_HISTOGRAM_BUCKET_COUNT,
    resolveRtcConnectStageId
} from '../../../apps/rallar-black-box/src/rtc-diagnostics.ts';
import { createRuntimeStateFixture } from '../shared-test/rallar-bb-runtime/create-runtime-state-fixture.ts';

const DIAGNOSTICS_NOW_EPOCH_MS = 100_000;
const RTC_DIAGNOSTIC_CONFIG: RallarBlackBoxTestConfig = {
    runId: 'run-1',
    agentId: 'agent-1',
    actor: 'alice',
    sessionId: 'alice-session',
    roomId: 'room-1',
    transport: 'realtime',
    apiBaseUrl: 'https://api.example.test',
    control: { providerMode: 'browser-rallar' },
    rallar: {
        username: 'alice',
        password: '<redacted>',
        restoreSession: true,
        logoutOnClose: true,
        leaveRoomOnClose: true
    },
    defaults: { connection: 'aliceRtc' }
};

interface RtcDiagnosticEventFixture {
    readonly eventId: string;
    readonly topic: string;
    readonly atEpochMs: number;
    readonly payload: ApiJsonObject;
}

interface RtcDiagnosticResultFixture {
    readonly commandId: string;
    readonly kind: RallarBlackBoxTestResult['kind'];
    readonly startedAtEpochMs: number;
    readonly durationMs: number;
}

function createRtcDiagnosticEvent(fixture: RtcDiagnosticEventFixture): RallarBlackBoxTestEvent {
    return {
        ...fixture,
        kind: 'diagnostic',
        connection: 'aliceRtc',
        actor: 'alice',
        transport: 'realtime',
        severity: 'info'
    };
}

function createRtcDiagnosticResult(fixture: RtcDiagnosticResultFixture): RallarBlackBoxTestResult {
    return {
        ...fixture,
        status: 'ok',
        ok: true,
        endedAtEpochMs: fixture.startedAtEpochMs + fixture.durationMs
    };
}

function createRtcDiagnosticState(
    events: readonly RallarBlackBoxTestEvent[],
    commandHistory: readonly RallarBlackBoxTestResult[]
): RallarBlackBoxTestState {
    const current = createRuntimeStateFixture(events);
    return {
        ...current,
        status: 'completed',
        currentConfig: RTC_DIAGNOSTIC_CONFIG,
        commandHistory,
        resultCache: Object.fromEntries(commandHistory.map((entry) => [entry.commandId, entry])),
        latestStats: {
            eventHistory: current.eventHistory,
            atEpochMs: 200,
            status: 'completed',
            counters: {
                commands: commandHistory.length,
                events: events.length,
                failures: 0,
                messages: events.filter((entry) => entry.kind === 'message').length,
                diagnostics: events.filter((entry) => entry.kind === 'diagnostic').length
            },
            commandLatency: {
                count: commandHistory.length,
                lastMs: commandHistory.at(-1)?.durationMs,
                averageMs: 25,
                maxMs: 70
            }
        }
    };
}

describe('rallar-black-box RTC diagnostics', () => {
    it('maps runtime topics and phases to connect stages', () => {
        expect(resolveRtcConnectStageId(createRtcDiagnosticEvent({ eventId: 'event-1', topic: 'rallar.browser.auth.completed', atEpochMs: 10, payload: {} })))
            .toBe('auth');
        expect(resolveRtcConnectStageId(createRtcDiagnosticEvent({
            eventId: 'event-2',
            topic: 'rallar.browser.connect.phase_failed',
            atEpochMs: 11,
            payload: {
                phase: 'peer-discovery'
            }
        }))).toBe('peer-discovery');
        expect(resolveRtcConnectStageId({
            ...createRtcDiagnosticEvent({ eventId: 'event-3', topic: 'rallar.browser.messages.rtc.message', atEpochMs: 12, payload: {} }),
            kind: 'message'
        })).toBe('first-payload');
    });

    it('derives timeline, membership, latency, and bundle data from runtime events', () => {
        const events: RallarBlackBoxTestEvent[] = [
            createRtcDiagnosticEvent({ eventId: 'event-auth', topic: 'rallar.browser.auth.completed', atEpochMs: 100, payload: { phase: 'auth' } }),
            createRtcDiagnosticEvent({ eventId: 'event-runtime', topic: 'rallar.browser.runtime.bootstrap_completed', atEpochMs: 120, payload: {} }),
            createRtcDiagnosticEvent({
                eventId: 'event-group',
                topic: 'rallar.browser.room.joined',
                atEpochMs: 140,
                payload: {
                    roomId: 'room-1',
                    sessionId: 'alice-session',
                    expectedClients: ['alice-session', 'bob-session'],
                    observedClients: ['alice-session'],
                    peerCount: 1,
                    laneHealth: 'opening'
                }
            }),
            createRtcDiagnosticEvent({ eventId: 'event-signal', topic: 'rallar.browser.signaling.ready', atEpochMs: 150, payload: {} }),
            createRtcDiagnosticEvent({
                eventId: 'event-peer',
                topic: 'rallar.browser.peer.discovered',
                atEpochMs: 160,
                payload: {
                    peerId: 'bob-session'
                }
            }),
            createRtcDiagnosticEvent({
                eventId: 'event-channel',
                topic: 'rallar.browser.data_channel.ready',
                atEpochMs: 170,
                payload: {
                    laneHealth: 'open',
                    readyPeerIds: ['alice-session', 'bob-session'],
                    activePeerIds: ['alice-session', 'bob-session']
                }
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
                        text: 'pong'
                    }
                }
            }
        ];
        const diagnostics = computeRtcDiagnostics(
            createRtcDiagnosticState(events, [
                createRtcDiagnosticResult({ commandId: 'connect-1', kind: 'rtc.connect', startedAtEpochMs: 90, durationMs: 85 }),
                createRtcDiagnosticResult({ commandId: 'send-1', kind: 'rtc.send', startedAtEpochMs: 180, durationMs: 12 })
            ]),
            DIAGNOSTICS_NOW_EPOCH_MS
        );

        expect(diagnostics.stages.map((stage) => [stage.stageId, stage.status])).toEqual([
            ['auth', 'observed'],
            ['runtime-bootstrap', 'observed'],
            ['group-join', 'observed'],
            ['signaling', 'observed'],
            ['peer-discovery', 'observed'],
            ['data-channel', 'observed'],
            ['first-payload', 'observed']
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
            staleClients: []
        });
        expect(diagnostics.latency).toMatchObject({
            connectMs: 85,
            firstPayloadMs: 10,
            firstPayloadFromConnectMs: 100,
            lastCommandMs: 12,
            averageCommandMs: 25,
            maxCommandMs: 70
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
                    leaveRoomOnClose: true
                }
            },
            commandIds: ['connect-1', 'send-1']
        });
    });

    it('surfaces failed connect stages and missing expected clients', () => {
        const failure = {
            ...createRtcDiagnosticEvent({
                eventId: 'event-failure',
                topic: 'rallar.browser.connect.phase_failed',
                atEpochMs: 150,
                payload: {
                    phase: 'data-channel',
                    error: {
                        message: 'channel timeout'
                    },
                    expectedClients: ['bob-session']
                }
            }),
            severity: 'error'
        } satisfies RallarBlackBoxTestEvent;
        const diagnostics = computeRtcDiagnostics(
            createRtcDiagnosticState([failure], [
                {
                    ...createRtcDiagnosticResult({ commandId: 'connect-1', kind: 'rtc.connect', startedAtEpochMs: 100, durationMs: 50 }),
                    status: 'failed',
                    ok: false,
                    error: {
                        code: 'RTC_TIMEOUT',
                        message: 'channel timeout'
                    }
                }
            ]),
            DIAGNOSTICS_NOW_EPOCH_MS
        );

        expect(diagnostics.stages.find((stage) => stage.stageId === 'data-channel')).toMatchObject({
            status: 'failed',
            topic: 'rallar.browser.connect.phase_failed'
        });
        expect(diagnostics.failure).toMatchObject({
            stageId: 'data-channel',
            source: 'rallar-runtime',
            message: 'channel timeout'
        });
        expect(diagnostics.membership.missingClients).toEqual(['bob-session']);
    });

    it('surfaces ready peers, active peers, lane health, and NACK evidence', () => {
        const diagnostics = computeRtcDiagnostics(
            createRtcDiagnosticState([
                createRtcDiagnosticEvent({
                    eventId: 'event-send',
                    topic: 'rallar.bb.fake.rtc.send_completed',
                    atEpochMs: 130,
                    payload: {
                        expectedClients: ['bob-session', 'charlie-session'],
                        readyPeerIds: ['bob-session'],
                        activePeerIds: ['bob-session'],
                        laneHealth: 'degraded',
                        peerCount: 1
                    }
                }),
                {
                    ...createRtcDiagnosticEvent({
                        eventId: 'event-nack',
                        topic: 'rallar.bb.fake.rtc.not-yet-in-sync',
                        atEpochMs: 140,
                        payload: {
                            negativeCase: 'not-yet-in-sync',
                            nack: {
                                code: 'not-yet-in-sync',
                                message: 'Snapshot is behind the minimum requested version.'
                            },
                            expectedClients: ['bob-session', 'charlie-session'],
                            observedClients: ['bob-session']
                        }
                    }),
                    severity: 'warning'
                }
            ], [
                createRtcDiagnosticResult({ commandId: 'send-1', kind: 'rtc.send', startedAtEpochMs: 120, durationMs: 20 })
            ]),
            DIAGNOSTICS_NOW_EPOCH_MS
        );

        expect(diagnostics.membership).toMatchObject({
            readyPeerIds: ['bob-session'],
            activePeerIds: ['bob-session'],
            missingClients: ['charlie-session'],
            nackCodes: ['not-yet-in-sync'],
            peerCount: 1,
            laneHealth: 'degraded'
        });
        expect(diagnostics.failure).toMatchObject({
            source: 'rallar-runtime',
            message: 'Snapshot is behind the minimum requested version.'
        });
    });

    it('derives RTC time-series buckets for events, messages, failures, and phase durations', () => {
        const sampleState = createRtcDiagnosticState([
            createRtcDiagnosticEvent({
                eventId: 'event-phase-1',
                topic: 'rallar.direct.rtc_realtime.phase',
                atEpochMs: 1_000,
                payload: {
                    phase: 'start',
                    durationMs: 10
                }
            }),
            {
                ...createRtcDiagnosticEvent({ eventId: 'event-message', topic: 'rallar.direct.rtc_realtime.message', atEpochMs: 2_000, payload: {} }),
                kind: 'message'
            },
            {
                ...createRtcDiagnosticEvent({ eventId: 'event-ws-message', topic: 'rallar.direct.ws.message', atEpochMs: 2_000, payload: {} }),
                kind: 'message',
                transport: 'ws'
            },
            {
                ...createRtcDiagnosticEvent({
                    eventId: 'event-failed',
                    topic: 'rallar.direct.rtc_realtime.phase',
                    atEpochMs: 3_000,
                    payload: {
                        phase: 'send',
                        durationMs: 30,
                        error: 'failed'
                    }
                }),
                severity: 'error'
            }
        ], []);
        const diagnostics = computeRtcDiagnostics(sampleState, DIAGNOSTICS_NOW_EPOCH_MS);
        const series = computeRtcDiagnosticsTimeseries(
            sampleState,
            {
                bucketCount: 4,
                bucketMs: 1_000,
                endAtEpochMs: 3_000,
                nowEpochMs: DIAGNOSTICS_NOW_EPOCH_MS
            }
        );

        expect(diagnostics.timeseries.map((entry) => entry.seriesId)).toEqual([
            'events',
            'messages',
            'failures',
            'phase-duration'
        ]);
        expect(series.find((entry) => entry.seriesId === 'events')?.points.map((point) => point.value))
            .toEqual([0, 1, 1, 1]);
        expect(series.find((entry) => entry.seriesId === 'messages')?.points.map((point) => point.value))
            .toEqual([0, 0, 1, 0]);
        expect(series.find((entry) => entry.seriesId === 'failures')?.points.map((point) => point.value))
            .toEqual([0, 0, 0, 1]);
        expect(series.find((entry) => entry.seriesId === 'phase-duration')?.points.map((point) => point.value))
            .toEqual([0, 10, 0, 30]);
    });

    it('derives scatter, distribution, waterfall, and lane matrix performance views', () => {
        const sampleState = createRtcDiagnosticState([
            createRtcDiagnosticEvent({ eventId: 'event-auth', topic: 'rallar.browser.auth.completed', atEpochMs: 100, payload: { phase: 'auth' } }),
            createRtcDiagnosticEvent({ eventId: 'event-runtime', topic: 'rallar.browser.runtime.bootstrap_completed', atEpochMs: 120, payload: {} }),
            createRtcDiagnosticEvent({
                eventId: 'event-group',
                topic: 'rallar.browser.room.joined',
                atEpochMs: 140,
                payload: {
                    roomId: 'room-1',
                    sessionId: 'alice-session',
                    expectedClients: ['alice-session', 'bob-session'],
                    observedClients: ['alice-session', 'bob-session']
                }
            }),
            createRtcDiagnosticEvent({ eventId: 'event-signal', topic: 'rallar.browser.signaling.ready', atEpochMs: 150, payload: {} }),
            createRtcDiagnosticEvent({
                eventId: 'event-peer',
                topic: 'rallar.browser.peer.discovered',
                atEpochMs: 160,
                payload: {
                    peerId: 'bob-session'
                }
            }),
            createRtcDiagnosticEvent({
                eventId: 'event-channel',
                topic: 'rallar.browser.data_channel.ready',
                atEpochMs: 170,
                payload: {
                    readyPeerIds: ['alice-session', 'bob-session'],
                    activePeerIds: ['alice-session'],
                    durationMs: 18
                }
            }),
            {
                ...createRtcDiagnosticEvent({ eventId: 'event-message', topic: 'rallar.browser.realtime.message', atEpochMs: 205, payload: {} }),
                kind: 'message'
            }
        ], [
            createRtcDiagnosticResult({ commandId: 'connect-1', kind: 'rtc.connect', startedAtEpochMs: 90, durationMs: 85 }),
            createRtcDiagnosticResult({ commandId: 'send-1', kind: 'rtc.send', startedAtEpochMs: 180, durationMs: 12 }),
            createRtcDiagnosticResult({ commandId: 'ws-1', kind: 'ws.send', startedAtEpochMs: 210, durationMs: 34 })
        ]);
        const diagnostics = computeRtcDiagnostics(sampleState, DIAGNOSTICS_NOW_EPOCH_MS);
        const performance = computeRtcPerformanceView({
            diagnostics,
            state: sampleState,
            distributedMonitor: undefined,
            histogramBucketCount: 3
        });

        expect(performance.summary).toMatchObject({
            commandCount: 3,
            p50Ms: 34,
            p95Ms: 85,
            p99Ms: 85,
            maxMs: 85,
            failureCount: 0
        });
        expect(performance.scatter.map((point) => [point.commandId, point.transport, point.durationMs])).toEqual([
            ['connect-1', 'rtc', 85],
            ['send-1', 'rtc', 12],
            ['ws-1', 'ws', 34]
        ]);
        expect(performance.histogram.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
        expect(performance.phaseSpans.map((span) => [span.stageId, span.status, span.endMs])).toContainEqual([
            'first-payload',
            'observed',
            115
        ]);
        expect(performance.phaseSpans.find((span) => span.stageId === 'data-channel')).toMatchObject({
            durationMs: 18,
            timingKind: 'duration',
            valueLabel: '18 ms duration'
        });
        expect(performance.phaseSpans.find((span) => span.stageId === 'first-payload')).toMatchObject({
            timingKind: 'observed-delta',
            valueLabel: '115 ms observed delta'
        });
        expect(performance.agentMatrix.map((cell) => [cell.laneId, cell.metric, cell.status])).toContainEqual([
            'bob-session',
            'active',
            'warn'
        ]);
        expect(performance.timeseries.map((series) => series.seriesId)).toEqual([
            'events',
            'messages',
            'failures',
            'phase-duration'
        ]);
    });

    it('adds distributed monitor agent timing to RTC performance views', () => {
        const sampleState = createRtcDiagnosticState([
            createRtcDiagnosticEvent({ eventId: 'event-runtime', topic: 'rallar.browser.runtime.bootstrap_completed', atEpochMs: 120, payload: {} })
        ], [
            createRtcDiagnosticResult({ commandId: 'send-1', kind: 'rtc.send', startedAtEpochMs: 180, durationMs: 12 })
        ]);
        const distributedMonitor: DistributedRunMonitor = {
            distributedRunId: 'distributed-1',
            state: 'completed',
            commandCounts: { total: 6, stage: 2, barrier: 2, start: 2, cancel: 0, completed: 6, failed: 1, pending: 0 },
            resultCounts: { total: 6, ok: 5, failed: 1 },
            compositeCounts: { total: 0, passed: 0, failed: 0, childResults: 0, composite: 0, leaf: 0 },
            diagnosticCounts: { total: 0, info: 0, warning: 0, error: 0, ws: 0, rtc: 0, http: 0, runtime: 0 },
            latency: { count: 6 },
            artifact: { status: 'not-loaded', fileCount: 0, message: 'No artifact loaded' },
            timeline: [],
            recipeProgress: [],
            readiness: [],
            failures: [],
            events: [],
            runtimeDiagnostics: [],
            compositeDrilldowns: [],
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
                    lastActivityAtEpochMs: 240
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
                    completedCommandCount: 3,
                    failedCommandCount: 1,
                    resultCount: 3,
                    eventCount: 1,
                    averageLatencyMs: 220,
                    lastActivityAtEpochMs: 260
                }
            ]
        };
        const performance = computeRtcPerformanceView({
            diagnostics: computeRtcDiagnostics(sampleState, DIAGNOSTICS_NOW_EPOCH_MS),
            state: sampleState,
            distributedMonitor,
            histogramBucketCount: 4
        });

        expect(performance.summary.commandCount).toBe(3);
        expect(performance.scatter.map((point) => [point.commandId, point.source, point.agentId, point.durationMs])).toEqual([
            ['send-1', 'local-result', 'agent-1', 12],
            ['agent-a', 'distributed-agent', 'agent-a', 42],
            ['agent-b', 'distributed-agent', 'agent-b', 220]
        ]);
        expect(performance.agentMatrix.map((cell) => [cell.laneId, cell.metric, cell.value, cell.status])).toEqual(expect.arrayContaining([
            ['agent-b', 'expected', 'yes', 'good'],
            ['agent-b', 'active', 'no', 'warn'],
            ['agent-b', 'missing', 'no', 'good']
        ]));
        expect(performance.histogram.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
    });

    it('returns explicit empty RTC performance states', () => {
        const emptyState = createRtcDiagnosticState([], []);
        const performance = computeRtcPerformanceView({
            diagnostics: computeRtcDiagnostics(emptyState, DIAGNOSTICS_NOW_EPOCH_MS),
            state: emptyState,
            distributedMonitor: undefined,
            histogramBucketCount: DEFAULT_RTC_PERFORMANCE_HISTOGRAM_BUCKET_COUNT
        });

        expect(performance.summary.commandCount).toBe(0);
        expect(performance.emptyReasons).toEqual([
            'No RTC/WS command results yet',
            'No RTC timeline events yet'
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
            ['rallar.browser.cleanup.room_leave_failed', 'rallar-cleanup']
        ] as const;

        for (const [topic, source] of cases) {
            const diagnostics = computeRtcDiagnostics(
                createRtcDiagnosticState([
                    {
                        ...createRtcDiagnosticEvent({
                            eventId: 'event-failure',
                            topic,
                            atEpochMs: 150,
                            payload: {
                                ...(topic.includes('phase_failed') ? { phase: 'room-join' } : {}),
                                error: {
                                    message: 'failure'
                                }
                            }
                        }),
                        severity: 'error'
                    }
                ], []),
                DIAGNOSTICS_NOW_EPOCH_MS
            );

            expect(diagnostics.failure).toMatchObject({
                source,
                message: 'failure'
            });
        }
    });
});
