import {
    describe,
    expect,
    it
} from 'vitest';

import { buildLiveRtcAgentDiagnostics } from '../../../tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts';
import { countUnexpectedLiveRtcDeliveries, type LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';

describe('live RTC diagnostic normalization', () => {
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
