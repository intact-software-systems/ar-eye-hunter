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
            peerId: (this.input as { peerId: string }).peerId,
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
        public rtcCallbacks:
            | {
            onOpen?: () => void;
        }
            | undefined;

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
        vi.useRealTimers();
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

        const first = service.ensurePeerConnectionStarted('z-peer');
        const second = service.ensurePeerConnectionStarted('z-peer');

        expect((first as unknown as { then?: unknown }).then).toBeUndefined();
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

        const first = service.ensurePeerConnectionStarted('z-peer');
        expect(first.left).toBeUndefined();
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);
        expect(service.connectedPeerIds()).toEqual(['z-peer']);

        mockState.dataChannels[0].readyToConnect = true;
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(service.connectedPeerIds()).toEqual([]);

        const second = service.ensurePeerConnectionStarted('z-peer');

        expect(second.right).toBe(first.right);
        expect(mockState.peerConnections).toHaveLength(1);
        expect(mockState.dataChannels[0].connect).toHaveBeenCalledTimes(2);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);
        expect(service.connectedPeerIds()).toEqual(['z-peer']);
    });

    it('reports known, active, lane-reconciled, and lane-ready peers separately', async () => {
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

        service.ensurePeerConnectionStarted('z-peer');

        expect(service.knownPeerIds()).toEqual(['z-peer']);
        expect(service.activePeerIds()).toEqual(['z-peer']);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual(['z-peer']);
        expect(service.connectedPeerIds()).toEqual(['z-peer']);
        expect(service.readyPeerIdsForLane()).toEqual([]);

        mockState.dataChannels[0].healthReadyState = 'open';
        expect(service.readyPeerIdsForLane()).toEqual(['z-peer']);

        mockState.dataChannels[0].readyToConnect = true;
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
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

        const connected = service.ensurePeerConnectionStarted('z-peer');

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
                            peerId: 'z-peer',
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
                            peerId: 'z-peer',
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

        service.ensurePeerConnectionStarted('z-peer');

        mockState.dataChannels[0].healthReadyState = 'open';
        mockState.dataChannels[1].healthReadyState = 'closed';
        mockState.dataChannels[1].readyToConnect = true;

        expect(service.activePeerIds()).toEqual(['z-peer']);
        expect(service.peerIdsWithNoReconnectableLanes()).toEqual([]);
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

    it('removes a stalled peer after the configured establishment timeout', async () => {
        vi.useFakeTimers();
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
                peerEstablishmentTimeout: {
                    enabled: true,
                    timeoutMs: 50,
                },
            },
        );
        const lifecycle: string[] = [];

        service.onRtcPeerLifecycleDo('lifecycle', {
            onCreated: (peer) => lifecycle.push(`created:${peer.peerId}`),
            onDeleted: (peer) => lifecycle.push(`deleted:${peer.peerId}`),
            onConnectTimeout: (_peer, event) => {
                lifecycle.push(`timeout:${event.peerId}:${event.timeoutMs}`);
            },
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
            'deleted:z-peer',
        ]);

        service.ensurePeerConnectionStarted('z-peer');

        expect(mockState.peerConnections).toHaveLength(2);
        expect(service.knownPeerIds()).toEqual(['z-peer']);
    });

    it('keeps a peer when the establishment timeout is cleared by an open lane', async () => {
        vi.useFakeTimers();
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
                peerEstablishmentTimeout: {
                    enabled: true,
                    timeoutMs: 50,
                },
            },
        );
        const lifecycle: string[] = [];

        service.onRtcPeerLifecycleDo('lifecycle', {
            onCreated: (peer) => lifecycle.push(`created:${peer.peerId}`),
            onDeleted: (peer) => lifecycle.push(`deleted:${peer.peerId}`),
            onConnectTimeout: (_peer, event) => {
                lifecycle.push(`timeout:${event.peerId}`);
            },
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

    it('ensures a requested peer lane is open after starting the connection', async () => {
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

        const result = await service.ensurePeerLaneOpen(
            'z-peer',
            'realtime',
            {
                timeoutMs: 25,
            },
        );

        expect(result).toMatchObject({
            status: 'open',
            peerId: 'z-peer',
            laneId: 'realtime',
        });
        expect(result.channel).toBe(mockState.dataChannels[1]);
        expect(mockState.dataChannels[1].waitUntilOpen).toHaveBeenCalledWith(25);
        expect(mockState.dataChannels[0].waitUntilOpen).not.toHaveBeenCalled();
    });

    it('reports missing and timed-out peer lanes without forcing cleanup by default', async () => {
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

        await expect(service.ensurePeerLaneOpen('z-peer', 'missing'))
            .resolves.toMatchObject({
                status: 'no-lane',
                peerId: 'z-peer',
                laneId: 'missing',
            });

        mockState.dataChannels[0].waitUntilOpen.mockResolvedValueOnce(false);

        await expect(
            service.ensurePeerLaneOpen('z-peer', 'reliable', { timeoutMs: 25 }),
        ).resolves.toMatchObject({
            status: 'timeout',
            peerId: 'z-peer',
            laneId: 'reliable',
        });

        expect(service.knownPeerIds()).toEqual(['z-peer']);
        expect(mockState.dataChannels[0].reset).not.toHaveBeenCalled();
    });

    it('can clean up a peer when explicit lane establishment fails', async () => {
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

        service.ensurePeerConnectionStarted('z-peer');
        mockState.dataChannels[0].waitUntilOpen.mockResolvedValueOnce(false);

        await expect(
            service.ensurePeerLaneOpen(
                'z-peer',
                'reliable',
                {
                    timeoutMs: 25,
                    cleanupOnFailure: true,
                },
            ),
        ).resolves.toMatchObject({
            status: 'timeout',
            peerId: 'z-peer',
            laneId: 'reliable',
        });

        expect(service.knownPeerIds()).toEqual([]);
        expect(mockState.dataChannels[0].reset).toHaveBeenCalledOnce();
        expect(mockState.peerConnections[0].reset).toHaveBeenCalledOnce();
    });

    it('reports aborted when lane establishment is cancelled while waiting', async () => {
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
        const deferred = createDeferred<boolean>();
        const controller = new AbortController();
        service.ensurePeerConnectionStarted('z-peer');
        mockState.dataChannels[0].waitUntilOpen.mockReturnValueOnce(deferred.promise);

        const wait = service.ensurePeerLaneOpen(
            'z-peer',
            'reliable',
            {
                signal: controller.signal,
                timeoutMs: 1_000,
            },
        );
        controller.abort('stop');

        await expect(wait).resolves.toMatchObject({
            status: 'aborted',
            peerId: 'z-peer',
            laneId: 'reliable',
        });
        deferred.resolve(false);
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

        expect(service.ensurePeerConnectionStarted('self')).toMatchObject({
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
        reject,
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
    readonly input: unknown;
};

type MockQRtcMediaChannel = {
    readonly connect: ReturnType<typeof vi.fn>;
    readonly reset: ReturnType<typeof vi.fn>;
};
