import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_EVENT_FILTERS,
    eventFilterFromValue,
    eventGroupValue,
    eventMatchesFilters,
    eventPeerValue,
    eventSelectorValue,
    type EventFilters
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/events/event-filters.ts';
import {
    eventFailureText,
    eventPayloadDetails,
    eventPayloadText,
    isRallarBrowserEvent,
    isRallarTraceEvent,
    rallarTraceSource,
    traceMetaText,
    traceTimingText
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/events/event-presentation.ts';
import {
    completedActionFeedback,
    idleActionFeedback,
    runningActionFeedback
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/shared/action-feedback.ts';
import { optionalNumber } from '../../../apps/rallar-black-box/src/legacy/shared/finite-number.ts';
import { deriveRallarBrowserStatus } from '../../../apps/rallar-black-box/src/legacy/shell/rallar-browser-status.ts';
import type { RallarBlackBoxTestEvent, RallarBlackBoxTestState } from '../../shared-test/rallar-bb-test/types.ts';

function event(
    overrides: Partial<RallarBlackBoxTestEvent> = {}
): RallarBlackBoxTestEvent {
    return {
        eventId: 'event-1',
        kind: 'diagnostic',
        topic: 'rallar.browser.rtc.connect_completed',
        atEpochMs: 1_000,
        commandId: 'command-1',
        connection: 'aliceRtc',
        actor: 'alice',
        transport: 'realtime',
        severity: 'warning',
        payload: {
            data: {
                roomRef: { groupId: 'group-1' },
                remotePeerId: 'peer-1',
                topicId: 'chat',
                typeId: 'message'
            }
        },
        ...overrides
    };
}

function state(
    events: readonly RallarBlackBoxTestEvent[]
): RallarBlackBoxTestState {
    return {
        status: 'completed',
        currentConfig: {
            roomId: 'config-room',
            transport: 'ws',
            defaults: { connection: 'config-connection' }
        },
        commandHistory: [],
        events,
        failures: [],
        resultCache: {}
    };
}

describe('diagnostic event filters', () => {
    it('normalizes invalid kinds and matches every filter field', () => {
        expect(eventFilterFromValue('message')).toBe('message');
        expect(eventFilterFromValue('invalid')).toBe('all');

        const candidate = event();
        const matching: EventFilters = {
            kind: 'diagnostic',
            commandId: 'command-1',
            connection: 'aliceRtc',
            actor: 'alice',
            transport: 'realtime',
            group: 'group-1',
            peer: 'peer-1',
            selector: 'chat / message',
            topic: 'BROWSER.RTC',
            severity: 'warning'
        };
        expect(eventMatchesFilters(candidate, matching)).toBe(true);

        for (
            const [field, value] of Object.entries({
                kind: 'message',
                commandId: 'other-command',
                connection: 'other-connection',
                actor: 'bob',
                transport: 'ws',
                group: 'other-group',
                peer: 'other-peer',
                selector: 'other / selector',
                topic: 'missing-topic',
                severity: 'error'
            })
        ) {
            expect(
                eventMatchesFilters(candidate, {
                    ...DEFAULT_EVENT_FILTERS,
                    [field]: value
                }),
                field
            ).toBe(false);
        }
    });

    it('derives nested group, peer, and selector values from payload data', () => {
        const candidate = event({
            payload: {
                roomRef: { groupId: 'top-level-group' },
                remotePeerId: 'top-level-peer',
                topicId: 'top-level-topic',
                typeId: 'top-level-type',
                data: {
                    roomRef: { groupId: 'nested-group' },
                    remotePeerId: 'nested-peer',
                    topicId: 'nested-topic',
                    typeId: 'nested-type'
                }
            }
        });

        expect(eventGroupValue(candidate)).toBe('nested-group');
        expect(eventPeerValue(candidate)).toBe('nested-peer');
        expect(eventSelectorValue(candidate)).toBe(
            'nested-topic / nested-type'
        );
    });
});

describe('diagnostic event presentation', () => {
    it('preserves payload-data precedence and trace classification', () => {
        const candidate = event({
            payload: {
                phase: 'top phase',
                message: 'top failure',
                data: {
                    phase: 'nested phase',
                    status: { readyState: 'open' },
                    message: 'nested failure'
                }
            }
        });

        expect(eventPayloadDetails(candidate)).toMatchObject({
            phase: 'nested phase',
            message: 'nested failure'
        });
        expect(eventPayloadText(candidate)).toBe('nested phase - open');
        expect(eventFailureText(candidate)).toBe('nested failure');
        expect(isRallarBrowserEvent(candidate)).toBe(true);
        expect(isRallarTraceEvent(candidate)).toBe(true);
        expect(rallarTraceSource(candidate)).toBe('browser');
        expect(
            rallarTraceSource(event({ topic: 'rallar.direct.ws.send' }))
        ).toBe('direct');
        expect(
            rallarTraceSource(event({ topic: 'rallar.server.rest' }))
        ).toBe('server');
        expect(
            isRallarTraceEvent(event({ topic: 'unrelated.runtime' }))
        ).toBe(false);
    });

    it('formats failure fallback, timing, and trace metadata', () => {
        const candidate = event({
            atEpochMs: 1_200,
            payload: { error: { message: 'lane failed' } }
        });
        const previous = event({ eventId: 'previous', atEpochMs: 1_000 });

        expect(eventFailureText(candidate)).toBe('lane failed');
        expect(traceTimingText(candidate, previous, 2_200)).toMatch(
            / - 1s ago - \+200 ms$/
        );
        expect(traceTimingText(candidate, undefined, 2_200)).toMatch(
            / - 1s ago - first$/
        );
        expect(traceMetaText(candidate)).toBe(
            'browser - diagnostic - warning - realtime - aliceRtc - alice'
        );
    });
});

describe('Rallar browser status evidence', () => {
    it('preserves WS, RTC, group, topic, and tone precedence', () => {
        const summary = deriveRallarBrowserStatus(
            state([
                event({
                    payload: {
                        data: {
                            wsStatus: {
                                readyState: 'open',
                                reconnecting: true,
                                reconnectExhausted: true,
                                connectState: 'connecting',
                                reconnectAttempts: 3,
                                maxReconnectAttempts: 4
                            },
                            rtcStatus: {
                                knownPeerIds: ['one', 'two'],
                                activePeerIds: ['one'],
                                readyPeerIds: ['one'],
                                peerIdsWithNoReconnectableLanes: ['two']
                            },
                            roomRef: { groupId: 'event-group' },
                            laneId: 'lane-1',
                            rallarConnected: true
                        }
                    }
                })
            ])
        );

        expect(summary).toMatchObject({
            signalingLabel: 'exhausted',
            signalingTone: 'warn',
            signalingDetail: 'connecting - 3/4 reconnects',
            rtcLabel: 'ready',
            rtcTone: 'warn',
            rtcDetail: 'lane-1',
            rtcGroup: 'event-group',
            rtcConnection: 'aliceRtc',
            rtcTransport: 'realtime',
            peerSummary: 'ready 1 / active 1 / known 2',
            latestTopic: 'rallar.browser.rtc.connect_completed',
            latestAtEpochMs: 1_000,
            rallarConnected: true
        });
    });

    it('returns exact empty and degraded summaries', () => {
        expect(deriveRallarBrowserStatus(state([]))).toMatchObject({
            signalingLabel: 'not observed',
            signalingTone: 'muted',
            signalingDetail: '-',
            rtcLabel: 'not observed',
            rtcTone: 'muted',
            rtcGroup: 'config-room',
            rtcConnection: 'config-connection',
            rtcTransport: 'ws',
            peerSummary: 'ready 0 / active 0 / known 0'
        });

        const degraded = deriveRallarBrowserStatus(
            state([
                event({
                    topic: 'rallar.browser.rtc.closed',
                    payload: {
                        rtcStatus: {
                            knownPeerIds: ['one'],
                            readyPeerIds: ['one']
                        }
                    }
                })
            ])
        );
        expect(degraded.rtcLabel).toBe('closed');
        expect(degraded.rtcTone).toBe('muted');
    });
});

describe('diagnostic action feedback', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('preserves idle, running, success, and error timing contracts', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);

        expect(idleActionFeedback('Ready.')).toEqual({
            state: 'idle',
            message: 'Ready.'
        });
        expect(runningActionFeedback('Send', '/target')).toEqual({
            state: 'running',
            label: 'Send',
            target: '/target',
            message: 'Action is running.',
            atEpochMs: 2_000
        });
        expect(
            completedActionFeedback({
                label: 'Send',
                startedAtEpochMs: 1_500,
                ok: true,
                durationMs: 75
            })
        ).toMatchObject({
            state: 'success',
            durationMs: 75,
            atEpochMs: 2_000
        });
        expect(
            completedActionFeedback({
                label: 'Send',
                startedAtEpochMs: 2_500,
                ok: false,
                message: 'failed'
            })
        ).toMatchObject({
            state: 'error',
            durationMs: 0,
            message: 'failed',
            atEpochMs: 2_000
        });
    });

    it('accepts only finite numbers', () => {
        expect(optionalNumber(42)).toBe(42);
        expect(optionalNumber(Number.NaN)).toBeUndefined();
        expect(optionalNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
        expect(optionalNumber('42')).toBeUndefined();
    });
});
