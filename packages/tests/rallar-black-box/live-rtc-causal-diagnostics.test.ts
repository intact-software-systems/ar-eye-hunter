import { describe, expect, it } from 'vitest';

import {
    toLiveRtcCausalEvents,
    toLiveRtcReadinessHealth
} from '../../../tests/playwright/rallar-black-box/live-rtc-causal-diagnostics.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import {
    jsonRecord,
    type LiveRtcJsonRecord
} from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

interface DiagnosticEventInput {
    readonly agentId: string;
    readonly topic: string;
    readonly atEpochMs: number;
    readonly data: LiveRtcJsonRecord;
}

function diagnosticEvent(input: DiagnosticEventInput): LiveRtcControlClient.Event {
    return {
        agentId: input.agentId,
        payload: {
            kind: 'diagnostic',
            topic: input.topic,
            atEpochMs: input.atEpochMs,
            payload: { data: input.data }
        }
    };
}

describe('live RTC causal diagnostics', () => {
    it('retains bounded signaling work evidence with explicit incomplete event coverage', () => {
        const sentinel = 'SENTINEL-must-not-be-retained';
        const unrelated: LiveRtcControlClient.Event[] = [];
        for (let index = 0; index < 1_792; index += 1) {
            unrelated.push(diagnosticEvent({
                agentId: 'agent-a',
                topic: 'unrelated',
                atEpochMs: index,
                data: { kind: 'ignored', payload: sentinel }
            }));
        }
        const peerEvents: LiveRtcControlClient.Event[] = [];
        for (let index = 0; index < 201; index += 1) {
            peerEvents.push(diagnosticEvent({
                agentId: 'agent-a',
                topic: 'rallar.browser.rtc.lifecycle',
                atEpochMs: 1_792 + index,
                data: { kind: 'peer-created', peerId: 'session-b' }
            }));
        }
        const events = [
            ...unrelated,
            ...peerEvents,
            diagnosticEvent({
                agentId: 'agent-a',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                atEpochMs: 1_993,
                data: {
                    kind: 'commit-phases',
                    typeId: 'rtc-signaling',
                    msgId: 'signal-1',
                    senderId: 'session-a',
                    commitOutcome: 'committed'
                }
            }),
            diagnosticEvent({
                agentId: 'agent-b',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                atEpochMs: 1_994,
                data: {
                    kind: 'admission-outcome',
                    typeId: 'rtc-signaling',
                    msgId: 'signal-1',
                    outcome: 'pending',
                    reason: sentinel
                }
            }),
            diagnosticEvent({
                agentId: 'agent-b',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                atEpochMs: 1_995,
                data: {
                    kind: 'claim-settled',
                    workerId: 'worker-1',
                    msgId: 'signal-1',
                    typeId: null,
                    payloadKind: 'dispatch-local',
                    durationMs: 4.5,
                    attempts: 2,
                    outcome: 'completed',
                    queueWaitMs: 9,
                    payload: sentinel
                }
            }),
            diagnosticEvent({
                agentId: 'agent-b',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                atEpochMs: 1_996,
                data: {
                    kind: 'claim-settled',
                    workerId: 'worker-1',
                    msgId: 'unrelated-message',
                    typeId: null,
                    payloadKind: 'dispatch-local',
                    durationMs: 1,
                    attempts: 1,
                    outcome: 'completed',
                    queueWaitMs: 1
                }
            }),
            diagnosticEvent({
                agentId: 'agent-b',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                atEpochMs: 1_997,
                data: {
                    kind: 'effect-drain',
                    workerId: 'worker-1',
                    durationMs: 20,
                    claimedCount: 3,
                    completedCount: 2,
                    rescheduledCount: 1,
                    rejectedCount: 0,
                    selectionDurationMs: 2,
                    claimDurationMs: 3,
                    runDurationMs: 12,
                    releaseDurationMs: 3,
                    queueWaitMs: 15,
                    payload: sentinel
                }
            }),
            diagnosticEvent({
                agentId: 'agent-a',
                topic: 'rallar.browser.rtc.lifecycle',
                atEpochMs: 1_998,
                data: {
                    kind: 'signaling-failed',
                    peerId: 'session-b',
                    signaling: {
                        signalKind: 'offer',
                        admission: {
                            outcome: 'rejected',
                            status: 'rate-limited',
                            messageId: 'signal-1'
                        },
                        reason: sentinel
                    }
                }
            }),
            diagnosticEvent({
                agentId: 'agent-b',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                atEpochMs: 1_999,
                data: {
                    kind: 'claim-settled',
                    workerId: 'worker/SENTINEL',
                    msgId: 'signal-1',
                    typeId: 'rtc-signaling',
                    payloadKind: 'dispatch-local',
                    durationMs: -1,
                    attempts: -1,
                    outcome: 'invented',
                    queueWaitMs: Number.NaN
                }
            })
        ];

        const projection = toLiveRtcCausalEvents({
            events,
            agentReferences: new Map([
                ['agent-a', 'agent-a'],
                ['agent-b', 'agent-b']
            ]),
            peerIds: ['session-a', 'session-b']
        });

        expect(projection.coverage).toEqual({
            runEventCount: 2_000,
            relevantEventCount: 206,
            retainedEventCount: 200,
            retainedTimeBounds: {
                firstAtEpochMs: 1_798,
                lastAtEpochMs: 1_998
            },
            projectionTruncated: true,
            defaultRuntimeTailCapacityReached: true,
            upstreamCompleteness: 'unknown',
            runtimeTailLimit: 'unknown',
            eventCoverageThroughHealthCapture: 'unknown'
        });
        expect(projection.events).toHaveLength(200);
        expect(projection.events.slice(-5)).toMatchObject([
            { kind: 'commit-phases', msgId: 'signal-1' },
            { kind: 'admission-outcome', msgId: 'signal-1' },
            {
                kind: 'claim-settled',
                workerId: 'worker-1',
                msgId: 'signal-1',
                typeId: null,
                payloadKind: 'dispatch-local',
                outcome: 'completed',
                attempts: 2,
                durationMs: 4.5,
                queueWaitMs: 9
            },
            {
                kind: 'effect-drain',
                evidenceScope: 'inbound-worker-batch-aggregate',
                claimedCount: 3,
                completedCount: 2,
                rescheduledCount: 1,
                rejectedCount: 0
            },
            {
                kind: 'signaling-failed',
                peerId: 'session-b',
                signaling: {
                    signalKind: 'offer',
                    admission: {
                        outcome: 'rejected',
                        status: 'rate-limited',
                        messageId: 'signal-1'
                    }
                }
            }
        ]);
        const serialized = JSON.stringify(projection);
        expect(serialized).not.toMatch(
            /SENTINEL|unrelated-message|invented|failure-secret|payload-secret/u
        );
        expect(projection.events.at(-2)).not.toHaveProperty('msgId');
        expect(projection.events.at(-2)).not.toHaveProperty('typeId');
    });

    it('retains bounded replacement-peer state with unknown lifetime and counter timing', () => {
        const sentinel = 'SENTINEL-must-not-be-retained';
        const additionalParticipantPeerIds: string[] = [];
        const additionalPeerDiagnostics: LiveRtcJsonRecord[] = [];
        for (let index = 0; index < 104; index += 1) {
            const peerId = `zz-session-${index.toString().padStart(3, '0')}`;
            additionalParticipantPeerIds.push(peerId);
            additionalPeerDiagnostics.push({
                peerId,
                connection: { state: 'Idle' },
                connectionDiagnostics: {},
                lanes: []
            });
        }
        const lanes: LiveRtcJsonRecord[] = [];
        for (let index = 0; index < 105; index += 1) {
            lanes.push({
                peerId: 'session-b',
                laneId: `lane-${index}`,
                isOpen: index === 0,
                channel: { label: sentinel }
            });
        }
        const result: LiveRtcControlClient.Result = {
            commandId: 'health',
            ok: true,
            result: {
                value: {
                    rallar: {
                        rtcStatus: { readyPeerIds: [], knownPeerIds: ['session-b', 'session-outside'] },
                        rtcDiagnostics: {
                            generatedAtEpochMs: 4_000,
                            peers: [
                                {
                                    peerId: 'session-b',
                                    connection: {
                                        state: 'Connecting',
                                        connectionState: 'connecting',
                                        iceConnectionState: 'checking',
                                        iceGatheringState: 'gathering',
                                        signalingState: 'have-local-offer',
                                        hasLocalDescription: true,
                                        hasRemoteDescription: false,
                                        makingOffer: true,
                                        ignoreOffer: false,
                                        iceCandidateQueueSize: 2,
                                        localStreamId: sentinel,
                                        remoteStreamIds: [sentinel],
                                        signaling: {
                                            outboundOfferCount: 1,
                                            outboundAnswerCount: 0,
                                            outboundIceCandidateCount: 3,
                                            inboundOfferCount: 0,
                                            inboundAnswerCount: 0,
                                            inboundIceCandidateCount: 0,
                                            outboundSignalingErrorCount: 1,
                                            inboundSignalingErrorCount: 0
                                        }
                                    },
                                    connectionDiagnostics: {
                                        staleAnswerIgnoredCount: 1,
                                        offerCollisionCount: 2,
                                        ignoredOfferCollisionCount: 3,
                                        politeOfferRollbackCount: 4,
                                        queuedIceCandidateCount: 5,
                                        addedIceCandidateCount: 6,
                                        flushedIceCandidateCount: 7,
                                        ignoredIceCandidateForIgnoredOfferCount: 8,
                                        outboundSignalingErrorCount: 1,
                                        inboundSignalingErrorCount: 0,
                                        pendingIceCandidateQueueLength: 2,
                                        reconnectAttemptsInFlight: -1
                                    },
                                    lanes,
                                    selectedCandidatePair: {
                                        local: { address: sentinel, url: sentinel },
                                        remote: { address: sentinel, url: sentinel }
                                    },
                                    statsError: sentinel
                                },
                                {
                                    peerId: 'session-outside',
                                    connection: { signalingState: sentinel },
                                    lanes: [],
                                    selectedCandidatePair: { local: { address: sentinel } }
                                },
                                ...additionalPeerDiagnostics
                            ]
                        }
                    }
                }
            }
        };

        const health = toLiveRtcReadinessHealth(result, [
            'session-b',
            ...additionalParticipantPeerIds
        ]);

        expect(health.rtcDiagnostics).toMatchObject({
            generatedAtEpochMs: 4_000,
            peerLifetimeCoverage: 'unknown',
            peerCounterTimeCoverage: 'unknown'
        });
        const rtcDiagnostics = jsonRecord(health.rtcDiagnostics);
        const peers = Array.isArray(rtcDiagnostics?.peers) ? rtcDiagnostics.peers : [];
        const firstPeer = jsonRecord(peers[0]);
        const firstPeerLanes = Array.isArray(firstPeer?.lanes) ? firstPeer.lanes : [];
        expect(peers).toHaveLength(100);
        expect(firstPeer).toMatchObject({
            peerId: 'session-b',
            connection: {
                state: 'Connecting',
                connectionState: 'connecting',
                iceConnectionState: 'checking',
                iceGatheringState: 'gathering',
                signalingState: 'have-local-offer',
                hasLocalDescription: true,
                hasRemoteDescription: false,
                makingOffer: true,
                ignoreOffer: false,
                iceCandidateQueueSize: 2,
                signaling: {
                    outboundOfferCount: 1,
                    outboundAnswerCount: 0,
                    outboundIceCandidateCount: 3,
                    inboundOfferCount: 0,
                    inboundAnswerCount: 0,
                    inboundIceCandidateCount: 0,
                    outboundSignalingErrorCount: 1,
                    inboundSignalingErrorCount: 0
                }
            },
            connectionDiagnostics: {
                staleAnswerIgnoredCount: 1,
                offerCollisionCount: 2,
                ignoredOfferCollisionCount: 3,
                politeOfferRollbackCount: 4,
                queuedIceCandidateCount: 5,
                addedIceCandidateCount: 6,
                flushedIceCandidateCount: 7,
                ignoredIceCandidateForIgnoredOfferCount: 8,
                outboundSignalingErrorCount: 1,
                inboundSignalingErrorCount: 0,
                pendingIceCandidateQueueLength: 2
            }
        });
        expect(firstPeerLanes).toHaveLength(100);
        expect(firstPeerLanes[0]).toEqual({ laneId: 'lane-0', isOpen: true });
        expect(JSON.stringify(health)).not.toMatch(/SENTINEL|candidate|address|url|stream|statsError/u);
        expect(toLiveRtcReadinessHealth(undefined, ['session-b']).rtcDiagnostics).toBeNull();
        expect(
            toLiveRtcReadinessHealth({ commandId: 'failed-health', ok: false }, ['session-b']).rtcDiagnostics
        ).toBeNull();
    });
});
