import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { WebRtcConnectionService } from '@shared/services/WebRtcConnectionService.ts';
import type { RtcDataChannelInputDto } from '@shared/webrtc/QRtcDataChannel.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingType,
    type QRtcSignalingMessage,
    type QRtcSignalingTransport,
    type QRtcSignalingTransportInputDto
} from '@shared/webrtc/QRtcSignalingContracts.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
    peerConnections: [] as MockQRtcPeerConnection[],
    dataChannels: [] as MockQRtcDataChannel[],
    mediaChannels: [] as MockQRtcMediaChannel[]
}));

vi.mock('@shared/webrtc/QRtcPeerConnection.ts', () => {
    class MockQRtcPeerConnection {
        public readonly status = {
            state: 'Idle',
            pc: {
                connectionState: 'new'
            }
        };
        public connectCallbacks:
            | {
                onConnected?: () => Promise<void>;
                onClosed?: (peerId: string) => Promise<void>;
            }
            | undefined;

        public readonly connect = vi.fn((callbacks = {}) => {
            this.connectCallbacks = callbacks;
        });
        public readonly handleSignal = vi.fn(async () => {
        });
        public readonly reset = vi.fn(() => {
            (this.status as any).pc = undefined;
            return this.status;
        });
        public readonly isOpen = vi.fn(() => false);
        public readonly isReadyToConnect = vi.fn(() => true);
        public readonly applyMediaPolicy = vi.fn();

        public readonly signaler: unknown;
        public readonly input: unknown;

        constructor(
            signaler: unknown,
            input: unknown
        ) {
            this.signaler = signaler;
            this.input = input;
            mockState.peerConnections.push(this);
        }
    }

    return {
        QRtcPeerConnection: MockQRtcPeerConnection
    };
});

vi.mock('@shared/webrtc/QRtcDataChannel.ts', () => {
    class MockQRtcDataChannel {
        public readyToConnect = false;
        public healthReadyState: RTCDataChannelState | undefined;
        public readonly connect = vi.fn(() => {
            this.readyToConnect = false;
        });
        public readonly reset = vi.fn();
        public readonly isReadyToConnect = vi.fn(() => this.readyToConnect);
        public readonly waitUntilOpen = vi.fn(async () => {
            this.healthReadyState = 'open';
            return true;
        });
        public readonly onRtcCallbacksDo = vi.fn((_id: string, callbacks: {
            onOpen?: () => void;
        }) => {
            this.rtcCallbacks = callbacks;
            return this;
        });
        public readonly removeRtcCallbackById = vi.fn((_id: string) => {
            this.rtcCallbacks = undefined;
            return true;
        });
        public readonly readHealth = vi.fn(() => ({
            peerId: this.input.peerId,
            label: this.input.dataChannelName,
            ...(this.healthReadyState
                ? {
                    readyState: this.healthReadyState
                }
                : {}),
            counters: {
                sent: 0
            }
        }));
        public rtcCallbacks:
            | {
                onOpen?: () => void;
            }
            | undefined;

        public readonly connection: unknown;
        public readonly input: RtcDataChannelInputDto;

        constructor(
            connection: unknown,
            input: RtcDataChannelInputDto
        ) {
            this.connection = connection;
            this.input = input;
            mockState.dataChannels.push(this);
        }
    }

    return {
        QRtcDataChannel: MockQRtcDataChannel
    };
});

vi.mock('@shared/webrtc/QRtcMediaChannel.ts', () => {
    class MockQRtcMediaChannel {
        public readonly connect = vi.fn();
        public readonly reset = vi.fn();
        public readonly onRemoteStreamDo = vi.fn(function (
            this: MockQRtcMediaChannel
        ) {
            return this;
        });
        public readonly onTrackDo = vi.fn(function (this: MockQRtcMediaChannel) {
            return this;
        });

        public readonly connection: unknown;
        public readonly input: unknown;

        constructor(
            connection: unknown,
            input: unknown
        ) {
            this.connection = connection;
            this.input = input;
            mockState.mediaChannels.push(this);
        }
    }

    return {
        QRtcMediaChannel: MockQRtcMediaChannel
    };
});

describe('WebRtcConnectionService', () => {
    beforeEach(() => {
        vi.useRealTimers();
        mockState.peerConnections.length = 0;
        mockState.dataChannels.length = 0;
        mockState.mediaChannels.length = 0;
        vi.restoreAllMocks();
    });

    it('connects the signaler and routes incoming signaling messages to peers', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('self')
        );

        await service.connectSignaler();

        expect(signaler.connect).toHaveBeenCalledOnce();

        const connectInput = getConnectInput(signaler);

        await expect(
            connectInput.callbacks.onMessage(
                'wrong-session',
                'token-1',
                createRtcEnvelope({
                    channel: QRtcSignalingChannel.RtcSignal,
                    type: QRtcSignalingMsgType.Signal,
                    fromId: 'peer-1',
                    toId: 'self',
                    sessionId: 'self',
                    token: 'token-1',
                    signalType: QRtcSignalingType.Offer,
                    payload: {
                        description: null,
                        candidate: null
                    }
                })
            )
        ).rejects.toThrow(
            'Message received for wrong session id: wrong-session expected: self'
        );

        await connectInput.callbacks.onMessage(
            'self',
            'token-1',
            createRtcEnvelope({
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: 'peer-1',
                toId: 'other',
                sessionId: 'other',
                token: 'token-1',
                signalType: QRtcSignalingType.Offer,
                payload: {
                    description: null,
                    candidate: null
                }
            })
        );

        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);

        await connectInput.callbacks.onMessage(
            'self',
            'token-1',
            createRtcEnvelope({
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: 'self',
                toId: 'self',
                sessionId: 'self',
                token: 'token-1',
                signalType: QRtcSignalingType.Offer,
                payload: {
                    description: null,
                    candidate: null
                }
            })
        );

        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);

        const firstMessage = createRtcEnvelope({
            channel: QRtcSignalingChannel.RtcSignal,
            type: QRtcSignalingMsgType.Signal,
            fromId: 'peer-1',
            toId: 'self',
            sessionId: 'self',
            token: 'token-1',
            signalType: QRtcSignalingType.Offer,
            payload: {
                description: {
                    type: 'offer',
                    sdp: 'offer'
                },
                candidate: null
            }
        });

        await connectInput.callbacks.onMessage('self', 'token-1', firstMessage);

        expect(mockState.peerConnections).toHaveLength(1);
        expect(mockState.peerConnections[0].handleSignal).toHaveBeenCalledTimes(1);

        const secondMessage = createRtcEnvelope({
            channel: QRtcSignalingChannel.RtcSignal,
            type: QRtcSignalingMsgType.Signal,
            fromId: 'peer-1',
            toId: 'self',
            sessionId: 'self',
            token: 'token-1',
            signalType: QRtcSignalingType.IceCandidate,
            payload: {
                description: null,
                candidate: {
                    candidate: 'ice-1'
                }
            }
        });

        await connectInput.callbacks.onMessage('self', 'token-1', secondMessage);

        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['peer-1']);
        expect(mockState.peerConnections[0].handleSignal).toHaveBeenCalledTimes(2);
    });

    it('does not create a missing peer from inbound signaling when the creation policy denies it', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('self')
        ).setInboundPeerCreationPolicy(({ peerId, signalType }) => peerId !== 'peer-1' || signalType !== QRtcSignalingType.Offer);

        await service.connectSignaler();
        const connectInput = getConnectInput(signaler);

        await connectInput.callbacks.onMessage(
            'self',
            'token-1',
            createRtcEnvelope({
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: 'peer-1',
                toId: 'self',
                sessionId: 'self',
                token: 'token-1',
                signalType: QRtcSignalingType.Offer,
                payload: {
                    description: {
                        type: 'offer',
                        sdp: 'offer'
                    },
                    candidate: null
                }
            })
        );

        expect(mockState.peerConnections).toHaveLength(0);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
    });

    it('does not create a missing peer when the creation policy returns a deny decision', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('self')
        ).setInboundPeerCreationPolicy(() => ({ decision: 'deny' }) as never);

        await service.connectSignaler();
        const connectInput = getConnectInput(signaler);

        await connectInput.callbacks.onMessage(
            'self',
            'token-1',
            createRtcEnvelope({
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: 'peer-1',
                toId: 'self',
                sessionId: 'self',
                token: 'token-1',
                signalType: QRtcSignalingType.Offer,
                payload: {
                    description: {
                        type: 'offer',
                        sdp: 'offer'
                    },
                    candidate: null
                }
            })
        );

        expect(mockState.peerConnections).toHaveLength(0);
        expect(service.knownPeerIds()).toEqual([]);
    });

    it('creates a tentative peer from an inbound offer while group ownership is still unknown', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('self')
        ).setInboundPeerCreationPolicy(() => ({ decision: 'tentative' }) as never);

        await service.connectSignaler();
        const connectInput = getConnectInput(signaler);

        await connectInput.callbacks.onMessage(
            'self',
            'token-1',
            createRtcEnvelope({
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: 'peer-unknown',
                toId: 'self',
                sessionId: 'self',
                token: 'token-1',
                signalType: QRtcSignalingType.Offer,
                payload: {
                    description: {
                        type: 'offer',
                        sdp: 'offer'
                    },
                    candidate: null
                }
            })
        );

        expect(mockState.peerConnections).toHaveLength(1);
        expect(mockState.peerConnections[0].handleSignal).toHaveBeenCalledOnce();
        expect(service.knownPeerIds()).toEqual(['peer-unknown']);
    });

    it('does not create a missing peer from an inbound answer', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('self')
        );

        await service.connectSignaler();
        const connectInput = getConnectInput(signaler);

        await connectInput.callbacks.onMessage(
            'self',
            'token-1',
            createRtcEnvelope({
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: 'peer-1',
                toId: 'self',
                sessionId: 'self',
                token: 'token-1',
                signalType: QRtcSignalingType.Answer,
                payload: {
                    description: {
                        type: 'answer',
                        sdp: 'answer'
                    },
                    candidate: null
                }
            })
        );

        expect(mockState.peerConnections).toHaveLength(0);
        expect(service.knownPeerIds()).toEqual([]);
    });

    it('applies inbound signaling to an existing peer even when the creation policy denies new peers', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('self')
        ).setInboundPeerCreationPolicy(() => false);

        service.ensurePeerConnectionStarted('peer-1');
        await service.connectSignaler();
        const connectInput = getConnectInput(signaler);

        await connectInput.callbacks.onMessage(
            'self',
            'token-1',
            createRtcEnvelope({
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: 'peer-1',
                toId: 'self',
                sessionId: 'self',
                token: 'token-1',
                signalType: QRtcSignalingType.IceCandidate,
                payload: {
                    description: null,
                    candidate: {
                        candidate: 'ice-1'
                    }
                }
            })
        );

        expect(mockState.peerConnections).toHaveLength(1);
        expect(mockState.peerConnections[0].handleSignal).toHaveBeenCalledOnce();
    });

    it('creates peers once, defaults initiator mode from politeness, and cleans up on close', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('a-self')
        );
        const lifecycle: string[] = [];

        service.onRtcPeerLifecycleDo('lifecycle', {
            onCreated: (peer) => lifecycle.push(`created:${peer.peerId}`),
            onDeleted: (peer) => lifecycle.push(`deleted:${peer.peerId}`)
        });

        const first = service.ensurePeerConnectionStarted('z-peer');
        const second = service.ensurePeerConnectionStarted('z-peer');

        expect((first as unknown as { then?: unknown; }).then).toBeUndefined();
        expect(first.left).toBeUndefined();
        expect(second.left).toBeUndefined();
        expect(first.right).toBe(second.right);
        expect(mockState.peerConnections).toHaveLength(1);
        expect(mockState.dataChannels[0].connect).toHaveBeenCalledWith(false);
        expect(mockState.mediaChannels[0].connect).toHaveBeenCalledOnce();
        expect(lifecycle).toEqual(['created:z-peer']);

        await mockState.peerConnections[0].connectCallbacks?.onClosed?.('z-peer');

        expect(mockState.dataChannels[0].reset).toHaveBeenCalledOnce();
        expect(mockState.mediaChannels[0].reset).toHaveBeenCalledOnce();
        expect(mockState.peerConnections[0].reset).toHaveBeenCalledOnce();
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(lifecycle).toEqual(['created:z-peer', 'deleted:z-peer']);
        expect(service.removeRtcPeerLifecycleById('lifecycle')).toBe(true);
        expect(service.disconnectPeer('missing')).toBe(false);
    });

    it('treats another session for the same user principal as a normal RTC peer', () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('alice-session-a')
        );

        const connected = service.ensurePeerConnectionStarted('alice-session-b');

        expect(connected.left).toBeUndefined();
        expect(connected.right?.peerId).toBe('alice-session-b');
        expect(service.knownPeerIds()).toEqual(['alice-session-b']);
        expect(mockState.peerConnections).toHaveLength(1);
        expect(mockState.dataChannels[0].input).toMatchObject({
            peerId: 'alice-session-b'
        });
    });

    it('rejects same-session RTC self connections without creating a peer', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('alice-session-a')
        );

        const connected = service.ensurePeerConnectionStarted('alice-session-a');
        const lane = await service.ensurePeerLaneOpen('alice-session-a');

        expect(connected.left).toEqual({
            kind: 'self',
            peerId: 'alice-session-a'
        });
        expect(lane).toMatchObject({
            status: 'self',
            peerId: 'alice-session-a',
            laneId: 'reliable'
        });
        expect(service.knownPeerIds()).toEqual([]);
        expect(mockState.peerConnections).toHaveLength(0);
    });

    it('disconnects one same-principal RTC session peer without removing other session peers', () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('alice-session-a')
        );

        service.ensurePeerConnectionStarted('alice-session-b');
        service.ensurePeerConnectionStarted('alice-session-c');

        expect(service.knownPeerIds()).toEqual([
            'alice-session-b',
            'alice-session-c'
        ]);
        expect(service.disconnectPeer('alice-session-b')).toBe(true);

        expect(service.knownPeerIds()).toEqual(['alice-session-c']);
        expect(mockState.dataChannels[0].reset).toHaveBeenCalledOnce();
        expect(mockState.peerConnections[0].reset).toHaveBeenCalledOnce();
        expect(mockState.dataChannels[1].reset).not.toHaveBeenCalled();
        expect(mockState.peerConnections[1].reset).not.toHaveBeenCalled();
    });

    it('reconnects stale data channels on an otherwise active peer', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('a-self')
        );

        const first = service.ensurePeerConnectionStarted('z-peer');
        expect(first.left).toBeUndefined();
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);

        mockState.dataChannels[0].readyToConnect = true;
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);

        const second = service.ensurePeerConnectionStarted('z-peer');

        expect(second.right).toBe(first.right);
        expect(mockState.peerConnections).toHaveLength(1);
        expect(mockState.dataChannels[0].connect).toHaveBeenCalledTimes(2);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);
    });

    it('reports known, active, lane-reconciled, and lane-ready peers separately', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('a-self')
        );

        service.ensurePeerConnectionStarted('z-peer');

        expect(service.knownPeerIds()).toEqual(['z-peer']);
        expect(service.activePeerIds()).toEqual(['z-peer']);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);
        expect(service.readyPeerIdsForLane()).toEqual([]);

        mockState.dataChannels[0].healthReadyState = 'open';
        expect(service.readyPeerIdsForLane()).toEqual(['z-peer']);

        mockState.dataChannels[0].readyToConnect = true;
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(service.activePeerIds()).toEqual(['z-peer']);
        expect(service.readyPeerIdsForLane()).toEqual(['z-peer']);
    });

    it('creates a reliable lane plus configured realtime lanes for each peer', async () => {
        const signaler = createSignaler();
        const realtimeFlowControl = {
            highWatermarkBytes: 1024,
            lowWatermarkBytes: 256,
            overflow: 'replace-by-key' as const,
            maxQueueItems: 8
        };
        const service = new WebRtcConnectionService(
            signaler,
            {
                ...createConnectionInput('a-self'),
                dataChannelLanes: [
                    {
                        id: 'realtime',
                        label: 'rtc-realtime',
                        init: {
                            ordered: false,
                            maxRetransmits: 0
                        },
                        binaryType: 'arraybuffer',
                        flowControl: realtimeFlowControl
                    }
                ]
            }
        );

        const connected = service.ensurePeerConnectionStarted('z-peer');

        expect(connected.left).toBeUndefined();
        expect(mockState.dataChannels).toHaveLength(2);
        expect(Array.from(connected.right?.channels.keys() ?? [])).toEqual([
            'reliable',
            'realtime'
        ]);
        expect(connected.right?.channel).toBe(mockState.dataChannels[0]);
        expect(service.readPeerChannel('z-peer')).toBe(mockState.dataChannels[0]);
        expect(service.readPeerChannel('z-peer', 'realtime')).toBe(
            mockState.dataChannels[1]
        );
        expect(mockState.dataChannels[0].input).toMatchObject({
            peerId: 'z-peer',
            dataChannelName: 'room'
        });
        expect(mockState.dataChannels[1].input).toMatchObject({
            peerId: 'z-peer',
            dataChannelName: 'rtc-realtime',
            dataChannelInit: {
                ordered: false,
                maxRetransmits: 0
            },
            binaryType: 'arraybuffer',
            flowControl: realtimeFlowControl
        });
        expect(mockState.dataChannels[0].connect).toHaveBeenCalledWith(false);
        expect(mockState.dataChannels[1].connect).toHaveBeenCalledWith(false);
        expect(service.readAllPeerHealth()).toEqual([
            {
                peerId: 'z-peer',
                channels: [
                    {
                        peerId: 'z-peer',
                        laneId: 'reliable',
                        channel: {
                            peerId: 'z-peer',
                            label: 'room',
                            counters: {
                                sent: 0
                            }
                        }
                    },
                    {
                        peerId: 'z-peer',
                        laneId: 'realtime',
                        channel: {
                            peerId: 'z-peer',
                            label: 'rtc-realtime',
                            counters: {
                                sent: 0
                            }
                        }
                    }
                ]
            }
        ]);
    });

    it('reports lane readiness separately when only the realtime lane is reconnectable', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            {
                ...createConnectionInput('a-self'),
                dataChannelLanes: [
                    {
                        id: 'realtime',
                        label: 'rtc-realtime'
                    }
                ]
            }
        );

        service.ensurePeerConnectionStarted('z-peer');

        mockState.dataChannels[0].healthReadyState = 'open';
        mockState.dataChannels[1].healthReadyState = 'closed';
        mockState.dataChannels[1].readyToConnect = true;

        expect(service.activePeerIds()).toEqual(['z-peer']);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(service.readyPeerIdsForLane()).toEqual(['z-peer']);
        expect(service.readyPeerIdsForLane('realtime')).toEqual([]);
        expect(service.readAllPeerHealth()).toMatchObject([
            {
                peerId: 'z-peer',
                channels: [
                    {
                        laneId: 'reliable',
                        channel: {
                            readyState: 'open'
                        }
                    },
                    {
                        laneId: 'realtime',
                        channel: {
                            readyState: 'closed'
                        }
                    }
                ]
            }
        ]);
    });

    it('removes a stalled peer after the configured establishment timeout', async () => {
        vi.useFakeTimers();
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            {
                ...createConnectionInput('a-self'),
                peerEstablishmentTimeout: {
                    enabled: true,
                    timeoutMs: 50
                }
            }
        );
        const lifecycle: string[] = [];

        service.onRtcPeerLifecycleDo('lifecycle', {
            onCreated: (peer) => lifecycle.push(`created:${peer.peerId}`),
            onDeleted: (peer) => lifecycle.push(`deleted:${peer.peerId}`),
            onConnectTimeout: (_peer, event) => {
                lifecycle.push(`timeout:${event.peerId}:${event.timeoutMs}`);
            }
        });

        service.ensurePeerConnectionStarted('z-peer');

        expect(service.knownPeerIds()).toEqual(['z-peer']);

        await vi.advanceTimersByTimeAsync(49);
        expect(service.knownPeerIds()).toEqual(['z-peer']);

        await vi.advanceTimersByTimeAsync(1);

        expect(service.knownPeerIds()).toEqual([]);
        expect(mockState.dataChannels[0].removeRtcCallbackById).toHaveBeenCalledOnce();
        expect(mockState.dataChannels[0].reset).toHaveBeenCalledOnce();
        expect(mockState.peerConnections[0].reset).toHaveBeenCalledOnce();
        expect(lifecycle).toEqual([
            'created:z-peer',
            'timeout:z-peer:50',
            'deleted:z-peer'
        ]);

        service.ensurePeerConnectionStarted('z-peer');

        expect(mockState.peerConnections).toHaveLength(2);
        expect(service.knownPeerIds()).toEqual(['z-peer']);
    });

    it('keeps a peer when the establishment timeout is cleared by an open lane', async () => {
        vi.useFakeTimers();
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            {
                ...createConnectionInput('a-self'),
                peerEstablishmentTimeout: {
                    enabled: true,
                    timeoutMs: 50
                }
            }
        );
        const lifecycle: string[] = [];

        service.onRtcPeerLifecycleDo('lifecycle', {
            onCreated: (peer) => lifecycle.push(`created:${peer.peerId}`),
            onDeleted: (peer) => lifecycle.push(`deleted:${peer.peerId}`),
            onConnectTimeout: (_peer, event) => {
                lifecycle.push(`timeout:${event.peerId}`);
            }
        });

        service.ensurePeerConnectionStarted('z-peer');

        mockState.dataChannels[0].healthReadyState = 'open';
        mockState.dataChannels[0].rtcCallbacks?.onOpen?.();
        await vi.advanceTimersByTimeAsync(50);

        expect(service.knownPeerIds()).toEqual(['z-peer']);
        expect(mockState.dataChannels[0].reset).not.toHaveBeenCalled();
        expect(mockState.peerConnections[0].reset).not.toHaveBeenCalled();
        expect(lifecycle).toEqual(['created:z-peer']);
    });

    it('exhausts repeated initial establishment attempts and cools down before retrying', async () => {
        vi.useFakeTimers();
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            {
                ...createConnectionInput('a-self'),
                peerEstablishmentTimeout: {
                    enabled: true,
                    timeoutMs: 50
                },
                peerConnectionAttemptBudget: {
                    enabled: true,
                    maxAttempts: 2,
                    maxTotalDurationMs: 100,
                    cooldownMs: 30
                }
            }
        );
        const lifecycle: string[] = [];

        service.onRtcPeerLifecycleDo('lifecycle', {
            onCreated: (peer) => lifecycle.push(`created:${peer.peerId}`),
            onDeleted: (peer) => lifecycle.push(`deleted:${peer.peerId}`),
            onConnectTimeout: (_peer, event) => {
                lifecycle.push(`timeout:${event.peerId}:${event.timeoutMs}`);
            },
            onConnectExhausted: (event) => {
                lifecycle.push(
                    `exhausted:${event.peerId}:${event.attempts}:${event.retryAfterEpochMs - event.exhaustedAtEpochMs}`
                );
            }
        });

        expect(service.ensurePeerConnectionStarted('z-peer').right?.peerId)
            .toBe('z-peer');
        await vi.advanceTimersByTimeAsync(50);
        expect(service.knownPeerIds()).toEqual([]);

        expect(service.ensurePeerConnectionStarted('z-peer').right?.peerId)
            .toBe('z-peer');
        await vi.advanceTimersByTimeAsync(50);
        expect(service.knownPeerIds()).toEqual([]);

        const exhausted = service.ensurePeerConnectionStarted('z-peer');

        expect(exhausted.left).toMatchObject({
            kind: 'connect-exhausted',
            peerId: 'z-peer',
            event: {
                peerId: 'z-peer',
                attempts: 2,
                maxAttempts: 2,
                maxTotalDurationMs: 100,
                cooldownMs: 30,
                reason: 'peer-connection-attempt-budget-exhausted'
            }
        });
        expect(service.knownPeerIds()).toEqual([]);
        expect(lifecycle).toContain('exhausted:z-peer:2:30');

        await vi.advanceTimersByTimeAsync(29);
        expect(service.ensurePeerConnectionStarted('z-peer').left)
            .toMatchObject({
                kind: 'connect-exhausted',
                peerId: 'z-peer'
            });

        await vi.advanceTimersByTimeAsync(1);
        expect(service.ensurePeerConnectionStarted('z-peer').right?.peerId)
            .toBe('z-peer');
        expect(service.knownPeerIds()).toEqual(['z-peer']);
    });

    it('clears initial attempt history once a lane opens', () => {
        vi.useFakeTimers();
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            {
                ...createConnectionInput('a-self'),
                peerEstablishmentTimeout: {
                    enabled: true,
                    timeoutMs: 50
                },
                peerConnectionAttemptBudget: {
                    enabled: true,
                    maxAttempts: 1,
                    maxTotalDurationMs: 50,
                    cooldownMs: 30
                }
            }
        );

        service.ensurePeerConnectionStarted('z-peer');

        expect(service.peerConnectionAttemptDiagnostics('z-peer')).toMatchObject({
            attempts: 1,
            peerId: 'z-peer'
        });

        mockState.dataChannels[0].healthReadyState = 'open';
        mockState.dataChannels[0].rtcCallbacks?.onOpen?.();

        expect(service.peerConnectionAttemptDiagnostics('z-peer')).toBeUndefined();
    });

    it('counts attempt-budget consumption, exhaustion, and reset evidence separately', async () => {
        vi.useFakeTimers();
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            {
                ...createConnectionInput('a-self'),
                peerEstablishmentTimeout: {
                    enabled: true,
                    timeoutMs: 50
                },
                peerConnectionAttemptBudget: {
                    enabled: true,
                    maxAttempts: 2,
                    maxTotalDurationMs: 100,
                    cooldownMs: 30
                }
            }
        );

        expect(service.readPeerConnectionAttemptBudgetDiagnostics()).toEqual({
            consumedCount: 0,
            resetOnSuccessCount: 0,
            resetOnRemovalCount: 0,
            cooldownExpiredClearCount: 0,
            exhaustedCount: 0
        });

        service.ensurePeerConnectionStarted('z-peer');
        await vi.advanceTimersByTimeAsync(50);
        service.ensurePeerConnectionStarted('z-peer');
        await vi.advanceTimersByTimeAsync(50);
        service.ensurePeerConnectionStarted('z-peer');

        expect(service.readPeerConnectionAttemptBudgetDiagnostics()).toMatchObject({
            consumedCount: 2,
            exhaustedCount: 1,
            cooldownExpiredClearCount: 0
        });

        await vi.advanceTimersByTimeAsync(30);
        service.ensurePeerConnectionStarted('z-peer');

        expect(service.readPeerConnectionAttemptBudgetDiagnostics()).toMatchObject({
            consumedCount: 3,
            cooldownExpiredClearCount: 1,
            resetOnSuccessCount: 0,
            resetOnRemovalCount: 0
        });

        service.disconnectPeer('z-peer');

        expect(service.readPeerConnectionAttemptBudgetDiagnostics()).toMatchObject({
            resetOnRemovalCount: 1,
            resetOnSuccessCount: 0
        });

        service.ensurePeerConnectionStarted('z-peer');
        mockState.dataChannels.at(-1)!.healthReadyState = 'open';
        mockState.dataChannels.at(-1)!.rtcCallbacks?.onOpen?.();

        expect(service.readPeerConnectionAttemptBudgetDiagnostics()).toMatchObject({
            consumedCount: 4,
            resetOnSuccessCount: 1,
            resetOnRemovalCount: 1
        });
    });

    it('ensures a requested peer lane is open after starting the connection', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            {
                ...createConnectionInput('a-self'),
                dataChannelLanes: [
                    {
                        id: 'realtime',
                        label: 'rtc-realtime'
                    }
                ]
            }
        );

        const result = await service.ensurePeerLaneOpen(
            'z-peer',
            'realtime',
            {
                timeoutMs: 25
            }
        );

        expect(result).toMatchObject({
            status: 'open',
            peerId: 'z-peer',
            laneId: 'realtime'
        });
        expect(result.channel).toBe(mockState.dataChannels[1]);
        expect(mockState.dataChannels[1].waitUntilOpen).toHaveBeenCalledWith(25);
        expect(mockState.dataChannels[0].waitUntilOpen).not.toHaveBeenCalled();
    });

    it('reports missing and timed-out peer lanes without forcing cleanup by default', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('a-self')
        );

        await expect(service.ensurePeerLaneOpen('z-peer', 'missing'))
            .resolves.toMatchObject({
                status: 'no-lane',
                peerId: 'z-peer',
                laneId: 'missing'
            });

        mockState.dataChannels[0].waitUntilOpen.mockResolvedValueOnce(false);

        await expect(
            service.ensurePeerLaneOpen('z-peer', 'reliable', { timeoutMs: 25 })
        ).resolves.toMatchObject({
            status: 'timeout',
            peerId: 'z-peer',
            laneId: 'reliable'
        });

        expect(service.knownPeerIds()).toEqual(['z-peer']);
        expect(mockState.dataChannels[0].reset).not.toHaveBeenCalled();
    });

    it('can clean up a peer when explicit lane establishment fails', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('a-self')
        );

        service.ensurePeerConnectionStarted('z-peer');
        mockState.dataChannels[0].waitUntilOpen.mockResolvedValueOnce(false);

        await expect(
            service.ensurePeerLaneOpen(
                'z-peer',
                'reliable',
                {
                    timeoutMs: 25,
                    cleanupOnFailure: true
                }
            )
        ).resolves.toMatchObject({
            status: 'timeout',
            peerId: 'z-peer',
            laneId: 'reliable'
        });

        expect(service.knownPeerIds()).toEqual([]);
        expect(mockState.dataChannels[0].reset).toHaveBeenCalledOnce();
        expect(mockState.peerConnections[0].reset).toHaveBeenCalledOnce();
    });

    it('reports aborted when lane establishment is cancelled while waiting', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('a-self')
        );
        const deferred = createDeferred<boolean>();
        const controller = new AbortController();
        service.ensurePeerConnectionStarted('z-peer');
        mockState.dataChannels[0].waitUntilOpen.mockReturnValueOnce(deferred.promise);

        const wait = service.ensurePeerLaneOpen(
            'z-peer',
            'reliable',
            {
                signal: controller.signal,
                timeoutMs: 1_000
            }
        );
        controller.abort('stop');

        await expect(wait).resolves.toMatchObject({
            status: 'aborted',
            peerId: 'z-peer',
            laneId: 'reliable'
        });
        deferred.resolve(false);
    });

    it('rejects self-connections', async () => {
        const signaler = createSignaler();
        const service = new WebRtcConnectionService(
            signaler,
            createConnectionInput('self')
        );

        expect(service.ensurePeerConnectionStarted('self')).toMatchObject({
            left: {
                kind: 'self',
                peerId: 'self'
            }
        });
    });
});

function createSignaler() {
    const signaler = {
        connect: vi.fn(async (_input: QRtcSignalingTransportInputDto) => {
        }),
        send: vi.fn(async (_payload: QRtcSignalingMessage) => {
        })
    };

    return signaler satisfies QRtcSignalingTransport;
}

function getConnectInput(
    signaler: ReturnType<typeof createSignaler>
): QRtcSignalingTransportInputDto {
    const connectInput = signaler.connect.mock.calls[0]?.[0];

    if (connectInput === undefined) {
        throw new Error('The service never connected the signaling transport.');
    }

    return connectInput;
}

function createConnectionInput(sessionId: string) {
    return {
        sessionId,
        token: 'token-1',
        dataChannelName: 'room',
        rtcSignalingTopicId: 'rtc',
        iceCandidates: {
            iceServers: [],
            expiresAtEpochMs: Date.now() + 1_000
        }
    };
}

function createRtcEnvelope(message: QRtcSignalingMessage) {
    return newALUnicastMessage(
        message.fromId,
        newALEventRoute('rtc', message.toId),
        message.toId,
        'rtc',
        message
    );
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return {
        promise,
        resolve,
        reject
    };
}

type MockQRtcPeerConnection = {
    readonly status: {
        state: string;
        pc:
            | {
                connectionState: string;
            }
            | undefined;
    };
    readonly connect: ReturnType<typeof vi.fn>;
    readonly handleSignal: ReturnType<typeof vi.fn>;
    readonly reset: ReturnType<typeof vi.fn>;
    readonly isOpen: ReturnType<typeof vi.fn>;
    readonly isReadyToConnect: ReturnType<typeof vi.fn>;
    connectCallbacks?: {
        onConnected?: () => Promise<void>;
        onClosed?: (peerId: string) => Promise<void>;
    };
};

type MockQRtcDataChannel = {
    readonly connect: ReturnType<typeof vi.fn>;
    readonly reset: ReturnType<typeof vi.fn>;
    readonly isReadyToConnect: ReturnType<typeof vi.fn>;
    readonly waitUntilOpen: ReturnType<typeof vi.fn>;
    readonly onRtcCallbacksDo: ReturnType<typeof vi.fn>;
    readonly removeRtcCallbackById: ReturnType<typeof vi.fn>;
    readonly readHealth: ReturnType<typeof vi.fn>;
    readyToConnect: boolean;
    healthReadyState?: RTCDataChannelState;
    rtcCallbacks?: {
        onOpen?: () => void;
    };
    readonly input: RtcDataChannelInputDto;
};

type MockQRtcMediaChannel = {
    readonly connect: ReturnType<typeof vi.fn>;
    readonly reset: ReturnType<typeof vi.fn>;
};
