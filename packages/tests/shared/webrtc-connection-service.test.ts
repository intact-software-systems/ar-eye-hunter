import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newALEventRoute, newALUnicastMessage, } from '@shared/al-contracts/al-contract.ts';
import {
    QRtcSignalingChannel,
    type QRtcSignalingMessage,
    QRtcSignalingMsgType,
    QRtcSignalingType,
} from '@shared/webrtc/QRtcSignalingContracts.ts';
import { WebRtcConnectionService } from '@shared/services/WebRtcConnectionService.ts';

const mockState = vi.hoisted(() => ({
    peerConnections: [] as MockQRtcPeerConnection[],
    dataChannels: [] as MockQRtcDataChannel[],
    mediaChannels: [] as MockQRtcMediaChannel[],
}));

vi.mock('@shared/webrtc/QRtcPeerConnection.ts', () => {
    class MockQRtcPeerConnection {
        public readonly status = {
            state: 'Idle',
            pc: {
                connectionState: 'new',
            },
        };
        public connectCallbacks:
            | {
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
        public readonly isReadyToConnect = vi.fn(() => true);
        public readonly applyMediaPolicy = vi.fn();

        constructor(
            public readonly signaler: unknown,
            public readonly input: unknown,
        ) {
            mockState.peerConnections.push(this);
        }
    }

    return {
        QRtcPeerConnection: MockQRtcPeerConnection,
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
        public readonly readHealth = vi.fn(() => ({
            label: (this.input as { dataChannelName: string }).dataChannelName,
            ...(this.healthReadyState
                ? {
                    readyState: this.healthReadyState,
                }
                : {}),
            counters: {
                sent: 0,
            },
        }));

        constructor(
            public readonly connection: unknown,
            public readonly input: { dataChannelName: string },
        ) {
            mockState.dataChannels.push(this);
        }
    }

    return {
        QRtcDataChannel: MockQRtcDataChannel,
    };
});

vi.mock('@shared/webrtc/QRtcMediaChannel.ts', () => {
    class MockQRtcMediaChannel {
        public readonly connect = vi.fn();
        public readonly reset = vi.fn();
        public readonly onRemoteStreamDo = vi.fn(function () {
            return this;
        });
        public readonly onTrackDo = vi.fn(function () {
            return this;
        });

        constructor(
            public readonly connection: unknown,
            public readonly input: unknown,
        ) {
            mockState.mediaChannels.push(this);
        }
    }

    return {
        QRtcMediaChannel: MockQRtcMediaChannel,
    };
});

describe('WebRtcConnectionService', () => {
    beforeEach(() => {
        mockState.peerConnections.length = 0;
        mockState.dataChannels.length = 0;
        mockState.mediaChannels.length = 0;
        vi.restoreAllMocks();
    });

    it('connects the signaler and routes incoming signaling messages to peers', async () => {
        const signaler = {
            connect: vi.fn(async () => {
            }),
            send: vi.fn(async () => {
            }),
        };
        const service = new WebRtcConnectionService(
            signaler as never,
            createConnectionInput('self'),
        );

        await service.connectSignaler();

        expect(signaler.connect).toHaveBeenCalledOnce();

        const connectInput = signaler.connect.mock.calls[0]?.[0];

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
                        candidate: null,
                    },
                }),
            ),
        ).rejects.toThrow(
            'Message received for wrong session id: wrong-session expected: self',
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
                    candidate: null,
                },
            }),
        );

        expect(service.connectedPeerIds()).toEqual([]);

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
                    candidate: null,
                },
            }),
        );

        expect(service.connectedPeerIds()).toEqual([]);

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
                    sdp: 'offer',
                },
                candidate: null,
            },
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
                    candidate: 'ice-1',
                },
            },
        });

        await connectInput.callbacks.onMessage('self', 'token-1', secondMessage);

        expect(service.connectedPeerIds()).toEqual(['peer-1']);
        expect(mockState.peerConnections[0].handleSignal).toHaveBeenCalledTimes(2);
    });

    it('creates peers once, defaults initiator mode from politeness, and cleans up on close', async () => {
        const signaler = {
            connect: vi.fn(async () => {
            }),
            send: vi.fn(async () => {
            }),
        };
        const service = new WebRtcConnectionService(
            signaler as never,
            createConnectionInput('a-self'),
        );
        const lifecycle: string[] = [];

        service.onRtcPeerLifecycleDo('lifecycle', {
            onCreated: (peer) => lifecycle.push(`created:${peer.peerId}`),
            onDeleted: (peer) => lifecycle.push(`deleted:${peer.peerId}`),
        });

        const [first, second] = await Promise.all([
            service.connectToPeerIfAbsent('z-peer'),
            service.connectToPeerIfAbsent('z-peer'),
        ]);

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
        expect(service.connectedPeerIds()).toEqual([]);
        expect(lifecycle).toEqual(['created:z-peer', 'deleted:z-peer']);
        expect(service.removeRtcPeerLifecycleById('lifecycle')).toBe(true);
        expect(service.disconnectPeer('missing')).toBe(false);
    });

    it('reconnects stale data channels on an otherwise active peer', async () => {
        const signaler = {
            connect: vi.fn(async () => {
            }),
            send: vi.fn(async () => {
            }),
        };
        const service = new WebRtcConnectionService(
            signaler as never,
            createConnectionInput('a-self'),
        );

        const first = await service.connectToPeerIfAbsent('z-peer');
        expect(first.left).toBeUndefined();
        expect(service.connectedPeerIds()).toEqual(['z-peer']);

        mockState.dataChannels[0].readyToConnect = true;
        expect(service.connectedPeerIds()).toEqual([]);

        const second = await service.connectToPeerIfAbsent('z-peer');

        expect(second.right).toBe(first.right);
        expect(mockState.peerConnections).toHaveLength(1);
        expect(mockState.dataChannels[0].connect).toHaveBeenCalledTimes(2);
        expect(service.connectedPeerIds()).toEqual(['z-peer']);
    });

    it('reports known, active, connected, and lane-ready peers separately', async () => {
        const signaler = {
            connect: vi.fn(async () => {
            }),
            send: vi.fn(async () => {
            }),
        };
        const service = new WebRtcConnectionService(
            signaler as never,
            createConnectionInput('a-self'),
        );

        await service.connectToPeerIfAbsent('z-peer');

        expect(service.knownPeerIds()).toEqual(['z-peer']);
        expect(service.activePeerIds()).toEqual(['z-peer']);
        expect(service.connectedPeerIds()).toEqual(['z-peer']);
        expect(service.readyPeerIdsForLane()).toEqual([]);

        mockState.dataChannels[0].healthReadyState = 'open';
        expect(service.readyPeerIdsForLane()).toEqual(['z-peer']);

        mockState.dataChannels[0].readyToConnect = true;
        expect(service.connectedPeerIds()).toEqual([]);
        expect(service.activePeerIds()).toEqual(['z-peer']);
        expect(service.readyPeerIdsForLane()).toEqual(['z-peer']);
    });

    it('creates a reliable lane plus configured realtime lanes for each peer', async () => {
        const signaler = {
            connect: vi.fn(async () => {
            }),
            send: vi.fn(async () => {
            }),
        };
        const realtimeFlowControl = {
            highWatermarkBytes: 1024,
            lowWatermarkBytes: 256,
            overflow: 'replace-by-key' as const,
            maxQueueItems: 8,
        };
        const service = new WebRtcConnectionService(
            signaler as never,
            {
                ...createConnectionInput('a-self'),
                dataChannelLanes: [
                    {
                        id: 'realtime',
                        label: 'rtc-realtime',
                        init: {
                            ordered: false,
                            maxRetransmits: 0,
                        },
                        binaryType: 'arraybuffer',
                        flowControl: realtimeFlowControl,
                    },
                ],
            },
        );

        const connected = await service.connectToPeerIfAbsent('z-peer');

        expect(connected.left).toBeUndefined();
        expect(mockState.dataChannels).toHaveLength(2);
        expect(Array.from(connected.right?.channels.keys() ?? [])).toEqual([
            'reliable',
            'realtime',
        ]);
        expect(connected.right?.channel).toBe(mockState.dataChannels[0]);
        expect(service.readPeerChannel('z-peer')).toBe(mockState.dataChannels[0]);
        expect(service.readPeerChannel('z-peer', 'realtime')).toBe(
            mockState.dataChannels[1],
        );
        expect(mockState.dataChannels[0].input).toMatchObject({
            peerId: 'z-peer',
            dataChannelName: 'room',
        });
        expect(mockState.dataChannels[1].input).toMatchObject({
            peerId: 'z-peer',
            dataChannelName: 'rtc-realtime',
            dataChannelInit: {
                ordered: false,
                maxRetransmits: 0,
            },
            binaryType: 'arraybuffer',
            flowControl: realtimeFlowControl,
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
                            label: 'room',
                            counters: {
                                sent: 0,
                            },
                        },
                    },
                    {
                        peerId: 'z-peer',
                        laneId: 'realtime',
                        channel: {
                            label: 'rtc-realtime',
                            counters: {
                                sent: 0,
                            },
                        },
                    },
                ],
            },
        ]);
    });

    it('reports lane readiness separately when only the realtime lane is reconnectable', async () => {
        const signaler = {
            connect: vi.fn(async () => {
            }),
            send: vi.fn(async () => {
            }),
        };
        const service = new WebRtcConnectionService(
            signaler as never,
            {
                ...createConnectionInput('a-self'),
                dataChannelLanes: [
                    {
                        id: 'realtime',
                        label: 'rtc-realtime',
                    },
                ],
            },
        );

        await service.connectToPeerIfAbsent('z-peer');

        mockState.dataChannels[0].healthReadyState = 'open';
        mockState.dataChannels[1].healthReadyState = 'closed';
        mockState.dataChannels[1].readyToConnect = true;

        expect(service.activePeerIds()).toEqual(['z-peer']);
        expect(service.connectedPeerIds()).toEqual([]);
        expect(service.readyPeerIdsForLane()).toEqual(['z-peer']);
        expect(service.readyPeerIdsForLane('realtime')).toEqual([]);
        expect(service.readAllPeerHealth()).toMatchObject([
            {
                peerId: 'z-peer',
                channels: [
                    {
                        laneId: 'reliable',
                        channel: {
                            readyState: 'open',
                        },
                    },
                    {
                        laneId: 'realtime',
                        channel: {
                            readyState: 'closed',
                        },
                    },
                ],
            },
        ]);
    });

    it('rejects self-connections', async () => {
        const signaler = {
            connect: vi.fn(async () => {
            }),
            send: vi.fn(async () => {
            }),
        };
        const service = new WebRtcConnectionService(
            signaler as never,
            createConnectionInput('self'),
        );

        await expect(service.connectToPeerIfAbsent('self')).resolves.toMatchObject({
            left: {
                kind: 'self',
                peerId: 'self',
            },
        });
    });
});

function createConnectionInput(sessionId: string) {
    return {
        sessionId,
        token: 'token-1',
        dataChannelName: 'room',
        rtcSignalingTopicId: 'rtc',
        iceCandidates: {
            iceServers: [],
            expiresAtEpochMs: Date.now() + 1_000,
        },
    };
}

function createRtcEnvelope(message: QRtcSignalingMessage) {
    return newALUnicastMessage(
        message.fromId,
        newALEventRoute('rtc', message.toId),
        message.toId,
        'rtc',
        message,
    );
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
    readonly isReadyToConnect: ReturnType<typeof vi.fn>;
    connectCallbacks?: {
        onClosed?: (peerId: string) => Promise<void>;
    };
};

type MockQRtcDataChannel = {
    readonly connect: ReturnType<typeof vi.fn>;
    readonly reset: ReturnType<typeof vi.fn>;
    readonly isReadyToConnect: ReturnType<typeof vi.fn>;
    readonly readHealth: ReturnType<typeof vi.fn>;
    readyToConnect: boolean;
    readonly input: unknown;
};

type MockQRtcMediaChannel = {
    readonly connect: ReturnType<typeof vi.fn>;
    readonly reset: ReturnType<typeof vi.fn>;
};
