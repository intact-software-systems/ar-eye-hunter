import {
    describe,
    expect,
    it
} from 'vitest';

import { buildLiveRtcAgentDiagnostics, decodeAgentDiagnostics } from '../../../tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts';
import { countUnexpectedLiveRtcDeliveries, type LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';

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
