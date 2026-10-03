import {
    describe,
    expect,
    it
} from 'vitest';

import {
    buildLiveRtcAgentDiagnostics,
    decodeAgentDiagnostics,
    toLiveRtcLifecycleHistory
} from '../../../tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts';
import { countUnexpectedLiveRtcDeliveries, type LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';

interface NotificationFixture {
    readonly name: string;
    readonly fields: object;
    readonly expected: object;
}

const unavailableNotifications: readonly NotificationFixture[] = [
    { name: 'absent', fields: {}, expected: { peerObservation: null, laneObservation: null } },
    { name: 'wrong-peer', fields: { peer: { peerId: 'other', connection: { state: 'Open' }, lanes: [] } }, expected: { peerObservation: null } },
    { name: 'wrong-lane-peer', fields: { lane: { peerId: 'other', laneId: 'realtime', isOpen: true } }, expected: { laneObservation: null } },
    { name: 'wrong-lane', fields: { lane: { peerId: 'session-b', laneId: 'other', isOpen: true } }, expected: { laneObservation: null } },
    {
        name: 'oversized-peer',
        fields: { peerId: 'p'.repeat(257), peer: { peerId: 'p'.repeat(257), connection: { state: 'Open' } } },
        expected: { peerId: null, peerObservation: null }
    },
    {
        name: 'oversized-lane',
        fields: { laneId: 'l'.repeat(257), lane: { peerId: 'session-b', laneId: 'l'.repeat(257), isOpen: true } },
        expected: { laneId: null, laneObservation: null }
    },
    { name: 'missing-connection-and-lanes', fields: { peer: { peerId: 'session-b' } }, expected: { peerObservation: { connection: null, lanes: null } } },
    { name: 'invalid-lane-collection', fields: { peer: { peerId: 'session-b', lanes: 'invalid' } }, expected: { peerObservation: { lanes: null } } },
    {
        name: 'invalid-lane-members',
        fields: { peer: { peerId: 'session-b', lanes: [null, { peerId: 'other', laneId: 'realtime' }, { peerId: 'session-b', laneId: 'l'.repeat(257) }] } },
        expected: { peerObservation: { lanes: [null, null, null] } }
    }
];

function toNotificationHistory(jsonl: string) {
    return toLiveRtcLifecycleHistory({
        jsonl,
        bytesRead: Buffer.byteLength(jsonl),
        retainedBytes: Buffer.byteLength(jsonl),
        retainedPrefixDropped: false,
        transportTruncated: false,
        failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' },
        cycle: 8,
        agentIds: ['agent-a', 'agent-b', 'agent-c']
    })['agent-a'];
}

describe('live RTC diagnostic normalization', () => {
    it('retains only bounded formation identity and readiness facts beside native RTC facts', () => {
        const diagnostics = buildLiveRtcAgentDiagnostics('agent-b', {
            rallar: {
                credential: 'secret-root-sentinel',
                rtcStatus: { activePeerIds: ['session-a'], readyPeerIds: ['session-a'] },
                rtcDiagnostics: {
                    sessionId: 'session-b',
                    generatedAtEpochMs: 123,
                    peerCount: 1,
                    connectedPeerCount: 1,
                    relayPeerCount: 0,
                    peers: [{
                        peerId: 'session-a',
                        connection: { reconnecting: false },
                        lanes: [{ laneId: 'messages.rtc', isOpen: true, isReconnectable: true }]
                    }]
                },
                formation: {
                    roomRef: { applicationId: 'app', workspaceId: 'space', groupId: 'room', token: 'secret-room-sentinel' },
                    stage: 'connecting',
                    payload: 'secret-payload-sentinel',
                    room: {
                        state: 'connecting',
                        desiredPeerIds: ['session-a', 'session-c'],
                        readyPeerIds: ['session-a'],
                        activePeerIds: ['session-a'],
                        failedPeerIds: [],
                        acceptedLayoutIdentity: { groupRevision: 2, presenceRevision: 3, version: 4, state: 'active', sdp: 'secret-sdp-sentinel' },
                        candidates: 'secret-candidate-sentinel'
                    }
                }
            }
        });

        expect(diagnostics.details).toMatchObject({
            formation: {
                observation: 'health-summary-not-readiness-wait-result',
                available: true,
                roomRef: { applicationId: 'app', workspaceId: 'space', groupId: 'room' },
                stage: 'connecting',
                roomTransportState: 'connecting',
                desiredPeerIds: ['session-a', 'session-c'],
                readyPeerIds: ['session-a'],
                activePeerIds: ['session-a'],
                failedPeerIds: [],
                acceptedLayoutIdentity: { groupRevision: 2, presenceRevision: 3, version: 4, state: 'active' }
            }
        });
        expect(diagnostics.laneStates).toEqual([{ peerId: 'session-a', laneId: 'messages.rtc', isOpen: true, isReconnectable: true }]);
        expect(JSON.stringify(diagnostics)).not.toContain('secret-');
    });

    it('reports unavailable formation explicitly without inventing peer or room state', () => {
        const diagnostics = buildLiveRtcAgentDiagnostics('agent-a', {
            rallar: {
                rtcStatus: { activePeerIds: [], readyPeerIds: [] },
                rtcDiagnostics: { generatedAtEpochMs: 123, peerCount: 0, connectedPeerCount: 0, relayPeerCount: 0, peers: [] }
            }
        });
        expect(diagnostics.details).toMatchObject({
            formation: { observation: 'health-summary-not-readiness-wait-result', available: false }
        });
    });

    it('bounds formation output and retains explicit missing fields without turning them into empty peers', () => {
        const diagnostics = buildLiveRtcAgentDiagnostics('agent-a', {
            rallar: {
                rtcStatus: { activePeerIds: [], readyPeerIds: [] },
                rtcDiagnostics: { generatedAtEpochMs: 123, peerCount: 0, connectedPeerCount: 0, relayPeerCount: 0, peers: [] },
                formation: {
                    stage: 'connecting',
                    roomRef: { groupId: 'x'.repeat(257) },
                    room: { state: 'secret-invalid-state-sentinel', desiredPeerIds: Array.from({ length: 101 }, () => 'session-b'), readyPeerIds: [42] }
                }
            }
        });
        expect(diagnostics.details).toMatchObject({
            formation: {
                available: true,
                roomRef: { applicationId: null, workspaceId: null, groupId: null },
                roomTransportState: null,
                desiredPeerIds: Array(100).fill('session-b'),
                readyPeerIds: null,
                activePeerIds: null,
                failedPeerIds: null,
                peerIdentitiesTruncated: true,
                acceptedLayoutIdentity: null
            }
        });
    });

    it('reads historical details and the current extension through the same unchanged checkpoint contract', () => {
        const historical = decodeAgentDiagnostics({
            agentId: 'agent-a',
            settledPeerIds: [],
            readyPeerIds: [],
            laneStates: [],
            connectionTimerActive: false,
            peerCount: 0,
            connectedPeerCount: 0,
            relayPeerCount: 0,
            details: { generatedAtEpochMs: 123, status: { activePeerIds: [], readyPeerIds: [] } }
        });
        const current = decodeAgentDiagnostics({
            agentId: 'agent-b',
            settledPeerIds: ['session-a'],
            readyPeerIds: ['session-a'],
            laneStates: [{ peerId: 'session-a', laneId: 'messages.rtc', isOpen: true, isReconnectable: true }],
            connectionTimerActive: false,
            peerCount: 1,
            connectedPeerCount: 1,
            relayPeerCount: 0,
            details: { generatedAtEpochMs: 456, formation: { available: true, stage: 'connecting' } }
        });
        expect(historical?.details).toEqual({ generatedAtEpochMs: 123, status: { activePeerIds: [], readyPeerIds: [] } });
        expect(current?.details).toEqual({ generatedAtEpochMs: 456, formation: { available: true, stage: 'connecting' } });
    });

    it('sorts stable state and distinguishes absent timers from active timers', () => {
        const stable = buildLiveRtcAgentDiagnostics('agent-a', {
            rallar: {
                rtcStatus: {
                    activePeerIds: ['peer-c', 'peer-b'],
                    readyPeerIds: ['peer-c', 'peer-b']
                },
                rtcDiagnostics: {
                    sessionId: 'session-a',
                    generatedAtEpochMs: 10,
                    peerCount: 2,
                    connectedPeerCount: 2,
                    relayPeerCount: 0,
                    peers: [
                        {
                            peerId: 'peer-c',
                            connection: {
                                disconnectPending: false,
                                reconnecting: false
                            },
                            lanes: [{
                                peerId: 'peer-c',
                                laneId: 'realtime',
                                isOpen: true,
                                isReconnectable: true
                            }]
                        },
                        {
                            peerId: 'peer-b',
                            connection: {
                                disconnectPending: false,
                                reconnecting: false
                            },
                            connectionDiagnostics: {
                                reconnectAttemptsInFlight: 0,
                                hasReconnectTimer: false
                            },
                            lanes: [{
                                peerId: 'peer-b',
                                laneId: 'messages.rtc',
                                isOpen: true,
                                isReconnectable: true
                            }]
                        }
                    ]
                }
            }
        });
        const activeTimer = buildLiveRtcAgentDiagnostics('agent-a', {
            rallar: {
                rtcStatus: {
                    activePeerIds: ['peer-b'],
                    readyPeerIds: ['peer-b']
                },
                rtcDiagnostics: {
                    sessionId: 'session-a',
                    generatedAtEpochMs: 11,
                    peerCount: 1,
                    connectedPeerCount: 1,
                    relayPeerCount: 0,
                    peers: [{
                        peerId: 'peer-b',
                        connection: {
                            disconnectPending: false,
                            reconnecting: false
                        },
                        connectionDiagnostics: {
                            reconnectAttemptsInFlight: 1,
                            hasReconnectTimer: true
                        },
                        lanes: []
                    }]
                }
            }
        });

        expect(stable).toMatchObject({
            settledPeerIds: ['peer-b', 'peer-c'],
            readyPeerIds: ['peer-b', 'peer-c'],
            laneStates: [
                expect.objectContaining({ peerId: 'peer-b' }),
                expect.objectContaining({ peerId: 'peer-c' })
            ],
            connectionTimerActive: false
        });
        expect(activeTimer.connectionTimerActive).toBe(true);
    });

    it('counts delivery to a receiver outside the scenario allowlist', () => {
        const scenario = {
            matrixId: 'direct-a-to-b',
            transport: 'realtime' as const,
            deliveryMode: 'direct' as const,
            senderAgentId: 'agent-a',
            expectedAgentIds: ['agent-b'],
            allowedAgentIds: ['agent-b']
        };
        const event = (agentId: string): LiveRtcControlClient.Event => ({
            agentId,
            payload: {
                kind: 'message',
                transport: 'realtime',
                payload: {
                    data: {
                        matrixId: scenario.matrixId,
                        deliveryMode: scenario.deliveryMode
                    }
                }
            }
        });

        expect(countUnexpectedLiveRtcDeliveries({
            events: [event('agent-b'), event('agent-c')],
            scenarios: [scenario]
        })).toBe(1);
    });
});

describe('lifecycle notification observations', () => {
    it.each(unavailableNotifications)('marks $name observations unavailable without substituting event.status', ({ fields, expected }) => {
        const jsonl = JSON.stringify({
            name: 'notification',
            agentId: 'agent-a',
            atEpochMs: 120,
            value: {
                topic: 'rallar.browser.rtc.lifecycle',
                payload: {
                    atEpochMs: 119,
                    data: {
                        kind: 'lane-error',
                        atEpochMs: 118,
                        peerId: 'session-b',
                        laneId: 'realtime',
                        status: { peers: [{ peerId: 'session-b', connection: { state: 'Open' } }] },
                        ...fields
                    }
                }
            }
        });
        expect(toNotificationHistory(jsonl)).toMatchObject({
            coverage: 'unknown',
            events: [{ eventId: 'notification', kind: 'lane-error', controlAtEpochMs: 120, observation: 'facade-current-at-notification', ...expected }]
        });
    });

    it('retains valid zeros and booleans while invalid fields stay null and raw roots stay private', () => {
        const jsonl =
            '{"name":"invalid-fields","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"lane-error","peerId":"session-b","laneId":"realtime","peer":{"peerId":"session-b","connection":{"state":"secret-field-sentinel","connectionState":"Open","iceConnectionState":"invented","iceGatheringState":"completed","signalingState":"connecting","hasLocalDescription":"false","hasRemoteDescription":false,"makingOffer":0,"iceCandidateQueueSize":-1,"signaling":{"outboundOfferCount":0,"outboundAnswerCount":null,"outboundIceCandidateCount":"3","inboundOfferCount":-1,"inboundIceCandidateCount":true,"outboundSignalingErrorCount":{},"inboundSignalingErrorCount":0},"localStreamId":"secret-field-sentinel","remoteStreamIds":["secret-field-sentinel"],"ignoreOffer":"secret-field-sentinel"},"lanes":[]},"lane":{"peerId":"session-b","laneId":"realtime","isOpen":"true","isReconnectable":false,"channel":{"readyState":"secret-field-sentinel","state":"secret-field-sentinel","candidate":"secret-field-sentinel"}},"status":"secret-field-sentinel","signaling":{"reason":"secret-field-sentinel"},"credentials":"secret-field-sentinel","error":"secret-field-sentinel"}}}}';
        const history = toNotificationHistory(jsonl);
        expect(history).toMatchObject({
            events: [{
                peerObservation: {
                    peerId: 'session-b',
                    connection: {
                        state: null,
                        connectionState: null,
                        iceConnectionState: null,
                        iceGatheringState: null,
                        signalingState: null,
                        hasLocalDescription: null,
                        hasRemoteDescription: false,
                        makingOffer: null,
                        iceCandidateQueueSize: null,
                        signaling: {
                            outboundOfferCount: 0,
                            outboundAnswerCount: null,
                            outboundIceCandidateCount: null,
                            inboundOfferCount: null,
                            inboundAnswerCount: null,
                            inboundIceCandidateCount: null,
                            outboundSignalingErrorCount: null,
                            inboundSignalingErrorCount: 0
                        }
                    },
                    lanes: []
                },
                laneObservation: { peerId: 'session-b', laneId: 'realtime', isOpen: null, isReconnectable: false, readyState: null }
            }]
        });
        expect(JSON.stringify(history)).not.toContain('secret-field-sentinel');
        expect(JSON.stringify(history)).not.toContain('ignoreOffer');
    });

    it('keeps event identity when legal JSON exponents overflow numeric observations', () => {
        const history = toNotificationHistory(
            '{"name":"overflow","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","peerId":"session-b","peer":{"peerId":"session-b","connection":{"iceCandidateQueueSize":1e400,"signaling":{"outboundOfferCount":1e400,"inboundOfferCount":0}},"lanes":[]}}}}}'
        );
        expect(history).toMatchObject({
            observed: { retainedRows: 1, malformedRows: 0 },
            events: [{
                eventId: 'overflow',
                peerObservation: {
                    connection: { iceCandidateQueueSize: null, signaling: { outboundOfferCount: null, inboundOfferCount: 0 } }
                }
            }]
        });
    });
});
