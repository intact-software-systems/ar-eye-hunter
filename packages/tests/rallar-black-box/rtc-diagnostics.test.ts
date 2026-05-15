import { describe, expect, it } from 'vitest';
import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
} from '../../shared-test/rallar-bb-test/types.ts';
import {
    deriveRtcDiagnostics,
    rtcConnectStageIdForEvent,
} from '../../../apps/rallar-black-box/src/rtc-diagnostics.ts';

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
            message: 'channel timeout',
        });
        expect(diagnostics.membership.missingClients).toEqual(['bob-session']);
    });
});
