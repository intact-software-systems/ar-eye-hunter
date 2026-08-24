import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { WebRtcHeartbeatServiceInputDto } from '@shared/services/WebRtcHeartbeatService.ts';
import { WebRtcRxStreamerService, type RttMeasurementCallbacks } from '@shared/services/WebRtcRxStreamerService.ts';
import type { OnQRtcMessageCallback } from '@shared/webrtc/QRtcClientCallbacks.ts';
import type { QRtcMediaPolicy } from '@shared/webrtc/QRtcPeerConnection.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
    heartbeats: [] as MockHeartbeatService[]
}));

vi.mock('@shared/services/WebRtcHeartbeatService.ts', () => {
    class MockHeartbeatService {
        public callbacks:
            | {
                onHeartbeat: (result: {
                    peerSessionId: string;
                    rttMsecs: number;
                    version: number;
                }) => Promise<void>;
                onMissedHeartbeat: (peerId: string) => Promise<void>;
            }
            | undefined;
        public readonly start = vi.fn((callbacks) => {
            this.startCount += 1;
            this.callbacks = callbacks;
        });
        public readonly stop = vi.fn(() => {
            this.stopCount += 1;
        });
        public startCount = 0;
        public stopCount = 0;

        public readonly input: WebRtcHeartbeatServiceInputDto;

        constructor(input: WebRtcHeartbeatServiceInputDto) {
            this.input = input;
            mockState.heartbeats.push(this);
        }
    }

    return {
        WebRtcHeartbeatService: MockHeartbeatService,
        defaultMaxMissedPings: 5,
        defaultPingFrequencyMsecs: 5_000
    };
});

describe('WebRtcRxStreamerService', () => {
    beforeEach(() => {
        mockState.heartbeats.length = 0;
        vi.restoreAllMocks();
    });

    it('hydrates new peers with cached media state and relays remote stream and RTT events', async () => {
        const service = new WebRtcRxStreamerService(
            new InMemoryQueueBox(new Map()),
            createFakeMulticastManager() as never,
            {
                sessionId: 'self'
            }
        );

        const localStream = createMediaStream('local-1');
        const policy = {
            maxVideoBitrateBps: 120_000,
            maxAudioBitrateBps: 48_000
        };
        const onRemoteStream = vi.fn(async () => {
        });
        const onRtcMessage = {
            onMessage: vi.fn(async () => {
            })
        };
        const onRttMeasurement = {
            onHeartbeat: vi.fn(async () => {
            })
        };

        await service.setLocalMediaStream(localStream);
        service.setLocalAudioEnabled(true);
        service.setLocalVideoEnabled(false);
        service.setMediaPolicy(policy);
        service.onRemoteStreamDo('remote', onRemoteStream);
        service.onRtcMessageDo('tap', onRtcMessage);
        service.onRttMeasurementDo('rtt', onRttMeasurement);

        const peer = createPeerDto('peer-1');
        service.addPeer(peer as never);

        expect(mockState.heartbeats).toHaveLength(0);
        expect(peer.connection.applyMediaPolicy).toHaveBeenCalledWith(policy);
        expect(peer.media.setParameters).toHaveBeenCalledWith(localStream, true, false);
        expect(peer.channel.onRtcCallbacksDo).toHaveBeenCalledWith(
            'self-peer-1-rtc-datachannel-lifecycle',
            expect.any(Object)
        );
        expect(peer.channel.onRtcMessageDo).toHaveBeenCalledWith(
            'self-peer-1-rtc-inbox',
            expect.any(Object)
        );
        expect(peer.channel.onRtcMessageDo).toHaveBeenCalledWith('tap', onRtcMessage);

        const lifecycle = peer.channel.lifecycleCallbacks.get(
            'self-peer-1-rtc-datachannel-lifecycle'
        );
        await lifecycle?.onOpen?.();

        expect(mockState.heartbeats).toHaveLength(1);
        expect(mockState.heartbeats[0].startCount).toBe(1);

        const remoteStream = createMediaStream('remote-1');
        const remoteEvent = createTrackEvent(remoteStream);
        await peer.media.emitRemoteStream(remoteStream, remoteEvent);

        expect(onRemoteStream).toHaveBeenCalledWith('peer-1', remoteStream, remoteEvent);

        await mockState.heartbeats[0].callbacks?.onHeartbeat({
            peerSessionId: 'peer-1',
            rttMsecs: 42,
            version: 3
        });

        expect(onRttMeasurement.onHeartbeat).toHaveBeenCalledWith({
            sessionIdFrom: 'self',
            sessionIdTo: 'peer-1',
            rttMs: 42,
            createdAtEpochMs: expect.any(Number),
            version: 3
        });

        service.addPeer(peer as never);
        expect(mockState.heartbeats).toHaveLength(1);
    });

    it('updates existing peers on media changes and tears down lifecycle wiring when removed', async () => {
        const service = new WebRtcRxStreamerService(
            new InMemoryQueueBox(new Map()),
            createFakeMulticastManager() as never,
            {
                sessionId: 'self'
            }
        );

        const peer = createPeerDto('peer-1');
        service.addPeer(peer as never);

        const lifecycle = peer.channel.lifecycleCallbacks.get(
            'self-peer-1-rtc-datachannel-lifecycle'
        );
        expect(lifecycle).toBeDefined();
        expect(mockState.heartbeats).toHaveLength(0);

        const localStream = createMediaStream('local-2');
        const policy = {
            preferredVideoCodecs: ['video/VP8']
        };

        await service.setLocalMediaStream(localStream);
        service.setLocalAudioEnabled(true);
        service.setLocalVideoEnabled(true);
        service.stopLocalMedia('video');
        service.setMediaPolicy(policy);

        expect(peer.media.localMediaStream).toBe(localStream);
        expect(peer.media.localAudioEnabled).toBe(true);
        expect(peer.media.localVideoEnabled).toBe(true);
        expect(peer.media.stoppedMediaKinds).toContain('video');
        expect(peer.connection.appliedMediaPolicy).toBe(policy);

        await lifecycle?.onOpen?.();

        expect(mockState.heartbeats).toHaveLength(1);
        const firstHeartbeat = mockState.heartbeats[0];

        await lifecycle?.onOpen?.();

        expect(firstHeartbeat.stopCount).toBe(1);
        expect(mockState.heartbeats).toHaveLength(2);

        await lifecycle?.onClose?.();

        expect(mockState.heartbeats[1].stopCount).toBe(1);

        service.removePeer(peer as never);

        expect(peer.media.removeOnRemoteStreamCallbackById).toHaveBeenCalledWith(
            'self-peer-1-rtc-media-remote-stream'
        );
        expect(peer.channel.removeOnRtcMessageCallbackById).toHaveBeenCalledWith(
            'self-peer-1-rtc-inbox'
        );
        expect(peer.channel.removeOnRtcMessageCallbackById).toHaveBeenCalledWith(
            'self-peer-1-rtc-datachannel-lifecycle'
        );
    });

    it('keeps RTT versions monotonic when a peer heartbeat restarts', async () => {
        const service = new WebRtcRxStreamerService(
            new InMemoryQueueBox(new Map()),
            createFakeMulticastManager() as never,
            { sessionId: 'self' }
        );
        const measurements: Parameters<RttMeasurementCallbacks['onHeartbeat']>[0][] = [];
        const onHeartbeat: RttMeasurementCallbacks['onHeartbeat'] = async (measurement) => {
            measurements.push(measurement);
        };
        service.onRttMeasurementDo('rtt', { onHeartbeat });

        const peer = createPeerDto('peer-1');
        service.addPeer(peer as never);
        const lifecycle = peer.channel.lifecycleCallbacks.get(
            'self-peer-1-rtc-datachannel-lifecycle'
        );

        await lifecycle?.onOpen?.();
        await mockState.heartbeats[0].callbacks?.onHeartbeat({
            peerSessionId: 'peer-1',
            rttMsecs: 10,
            version: 2
        });
        await lifecycle?.onOpen?.();
        await mockState.heartbeats[1].callbacks?.onHeartbeat({
            peerSessionId: 'peer-1',
            rttMsecs: 11,
            version: 2
        });

        expect(measurements.map((rtt) => rtt.version)).toEqual([2, 3]);
    });

    it('does not start RTT heartbeats for peers outside the reporting set', async () => {
        const service = new WebRtcRxStreamerService(
            new InMemoryQueueBox(new Map()),
            createFakeMulticastManager() as never,
            { sessionId: 'self' }
        );
        service.setRttReportingPeerIds(['peer-1']);

        const peer1 = createPeerDto('peer-1');
        const peer2 = createPeerDto('peer-2');
        service.addPeer(peer1 as never);
        service.addPeer(peer2 as never);

        await peer1.channel.lifecycleCallbacks
            .get('self-peer-1-rtc-datachannel-lifecycle')?.onOpen?.();
        await peer2.channel.lifecycleCallbacks
            .get('self-peer-2-rtc-datachannel-lifecycle')?.onOpen?.();

        expect(mockState.heartbeats).toHaveLength(1);
        expect((mockState.heartbeats[0].input as { peerSessionId: string; }).peerSessionId)
            .toBe('peer-1');
    });

    it('stops RTT heartbeats when a peer leaves the reporting set', async () => {
        const service = new WebRtcRxStreamerService(
            new InMemoryQueueBox(new Map()),
            createFakeMulticastManager() as never,
            { sessionId: 'self' }
        );
        service.setRttReportingPeerIds(['peer-1']);

        const peer = createPeerDto('peer-1');
        service.addPeer(peer as never);
        await peer.channel.lifecycleCallbacks
            .get('self-peer-1-rtc-datachannel-lifecycle')?.onOpen?.();

        service.setRttReportingPeerIds([]);

        expect(mockState.heartbeats[0].stopCount).toBe(1);
    });

    it('starts RTT heartbeat for an already-open peer when it enters the reporting set', async () => {
        const service = new WebRtcRxStreamerService(
            new InMemoryQueueBox(new Map()),
            createFakeMulticastManager() as never,
            { sessionId: 'self' }
        );
        service.setRttReportingPeerIds([]);

        const peer = createPeerDto('peer-1');
        service.addPeer(peer as never);
        await peer.channel.lifecycleCallbacks
            .get('self-peer-1-rtc-datachannel-lifecycle')?.onOpen?.();

        expect(mockState.heartbeats).toHaveLength(0);

        service.setRttReportingPeerIds(['peer-1']);

        expect(mockState.heartbeats).toHaveLength(1);
    });
});

class FakeRtcChannel {
    public readonly lifecycleCallbacks = new Map<string, {
        onOpen?: () => Promise<void>;
        onError?: () => Promise<void>;
        onClose?: () => Promise<void>;
    }>();
    public readonly messageCallbacks = new Map<string, OnQRtcMessageCallback>();
    public readonly onRtcCallbacksDo = vi.fn(
        (
            id: string,
            callbacks: {
                onOpen?: () => Promise<void>;
                onError?: () => Promise<void>;
                onClose?: () => Promise<void>;
            }
        ) => {
            this.lifecycleCallbacks.set(id, callbacks);
            return this;
        }
    );
    public readonly onRtcMessageDo = vi.fn((id: string, callback: OnQRtcMessageCallback) => {
        this.messageCallbacks.set(id, callback);
        return this;
    });
    public readonly removeOnRtcMessageCallbackById = vi.fn((id: string) => {
        return this.messageCallbacks.delete(id) || this.lifecycleCallbacks.delete(id);
    });
    public readonly sendAsJsonString = vi.fn(async () => {
    });
    public readonly send = vi.fn(async () => {
    });
    public readonly isOpen = vi.fn(() => true);
}

class FakeRtcMedia {
    public readonly remoteStreamCallbacks = new Map<string, RemoteStreamCallback>();
    public localMediaStream: MediaStream | undefined;
    public localAudioEnabled: boolean | undefined;
    public localVideoEnabled: boolean | undefined;
    public readonly stoppedMediaKinds: string[] = [];
    public readonly onRemoteStreamDo = vi.fn(
        (id: string, cb: RemoteStreamCallback) => {
            this.remoteStreamCallbacks.set(id, cb);
            return this;
        }
    );
    public readonly removeOnRemoteStreamCallbackById = vi.fn((id: string) => {
        return this.remoteStreamCallbacks.delete(id);
    });
    public readonly setParameters = vi.fn(async () => {
    });
    public readonly setLocalMediaStream = vi.fn(async (stream: MediaStream) => {
        this.localMediaStream = stream;
    });
    public readonly setLocalAudioEnabled = vi.fn((enabled: boolean) => {
        this.localAudioEnabled = enabled;
    });
    public readonly setLocalVideoEnabled = vi.fn((enabled: boolean) => {
        this.localVideoEnabled = enabled;
    });
    public readonly stopLocalMedia = vi.fn((kind: string) => {
        this.stoppedMediaKinds.push(kind);
    });

    async emitRemoteStream(stream: MediaStream, event: RTCTrackEvent): Promise<void> {
        for (const callback of this.remoteStreamCallbacks.values()) {
            await callback(stream, event);
        }
    }
}

type MockHeartbeatService = {
    readonly input: WebRtcHeartbeatServiceInputDto;
    readonly start: ReturnType<typeof vi.fn>;
    readonly stop: ReturnType<typeof vi.fn>;
    readonly startCount: number;
    readonly stopCount: number;
    callbacks?:
        | {
            onHeartbeat: (result: {
                peerSessionId: string;
                rttMsecs: number;
                version: number;
            }) => Promise<void>;
            onMissedHeartbeat: (peerId: string) => Promise<void>;
        }
        | undefined;
};

type RemoteStreamCallback = (
    stream: MediaStream,
    event: RTCTrackEvent
) => Promise<void>;

function createPeerDto(peerId: string) {
    const connection = {
        appliedMediaPolicy: undefined as QRtcMediaPolicy | undefined,
        applyMediaPolicy: vi.fn((policy: QRtcMediaPolicy) => {
            connection.appliedMediaPolicy = policy;
        })
    };
    return {
        peerId,
        channel: new FakeRtcChannel(),
        media: new FakeRtcMedia(),
        connection
    };
}

function createFakeMulticastManager() {
    return {
        planIncomingMessage: vi.fn(),
        enqueueIfAbsent: vi.fn(async () => []),
        acceptControlMessage: vi.fn(async () => {
        }),
        forwardIfRequired: vi.fn(async () => [])
    };
}

function createMediaStream(id: string): MediaStream {
    return { id } as MediaStream;
}

function createTrackEvent(stream: MediaStream): RTCTrackEvent {
    const event = new Event('track') as RTCTrackEvent;
    Object.defineProperty(event, 'streams', { value: [stream] });
    return event;
}
