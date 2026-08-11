import { afterEach, describe, expect, it, vi } from 'vitest';
import { QRtcPeerConnection } from '@shared/webrtc/QRtcPeerConnection.ts';
import { QRtcSignalingType } from '@shared/webrtc/QRtcSignalingContracts.ts';

describe('QRtcPeerConnection', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        FakeRTCPeerConnection.instances.length = 0;
    });

    it('negotiates offers, forwards ICE candidates, and dispatches remote events', async () => {
        vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);

        const signaler = {
            send: vi.fn(async () => {
            }),
        };
        const peer = new QRtcPeerConnection(
            signaler as never,
            createPeerInput(true),
        );
        const seenDataChannels: string[] = [];
        const seenTracks: string[] = [];
        const seenStreams: string[] = [];
        const onConnected = vi.fn(async () => {
        });

        peer.onDataChannelDo('dc', async (event) => {
            seenDataChannels.push(event.channel.label);
        });
        peer.onTrackDo('track', async (event) => {
            seenTracks.push(event.track.kind);
        });
        peer.onRemoteStreamDo('stream', async (stream) => {
            seenStreams.push(stream.id);
        });

        peer.connect({
            onConnected,
        });

        const pc = FakeRTCPeerConnection.instances[0];

        await pc.onnegotiationneeded?.();
        await pc.onicecandidate?.({
            candidate: {
                candidate: 'ice-1',
            },
        });
        await pc.ondatachannel?.({
            channel: new FakeRTCDataChannel('chat'),
        } as RTCDataChannelEvent);
        await pc.ontrack?.({
            track: createFakeTrack('video'),
            streams: [createFakeStream('remote-1', [createFakeTrack('audio')])],
        } as RTCTrackEvent);

        pc.connectionState = 'connected';
        pc.onconnectionstatechange?.();

        expect(signaler.send).toHaveBeenNthCalledWith(1, {
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'self',
            toId: 'peer-1',
            sessionId: 'self',
            token: 'token-1',
            signalType: 'Offer',
            payload: {
                description: {
                    type: 'offer',
                    sdp: 'offer-sdp',
                },
                candidate: null,
            },
        });
        expect(signaler.send).toHaveBeenNthCalledWith(2, {
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'self',
            toId: 'peer-1',
            sessionId: 'self',
            token: 'token-1',
            signalType: 'IceCandidate',
            payload: {
                description: null,
                candidate: {
                    candidate: 'ice-1',
                },
            },
        });
        expect(seenDataChannels).toEqual(['chat']);
        expect(seenTracks).toEqual(['video']);
        expect(seenStreams).toEqual(['remote-1']);
        expect(onConnected).toHaveBeenCalledOnce();
        expect(peer.isOpen()).toBe(true);
        expect(peer.readDiagnostics()).toMatchObject({
            connectCallCount: 1,
            connectIgnoredCount: 0,
            negotiationNeededCount: 1,
            negotiationSkippedCount: 0,
            offerCreatedCount: 1,
            outboundOfferCount: 1,
            outboundIceCandidateCount: 1,
            pendingIceCandidateQueueLength: 0,
            reconnectAttemptsInFlight: 0,
            hasReconnectTimer: false,
        });

        peer.resetDiagnostics();

        expect(peer.readDiagnostics()).toMatchObject({
            connectCallCount: 0,
            negotiationNeededCount: 0,
            outboundOfferCount: 0,
            outboundIceCandidateCount: 0,
        });
    });

    it('queues ice candidates until a remote description exists and answers remote offers', async () => {
        vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);

        const signaler = {
            send: vi.fn(async () => {
            }),
        };
        const peer = new QRtcPeerConnection(
            signaler as never,
            createPeerInput(true),
        );

        peer.connect();

        const pc = FakeRTCPeerConnection.instances[0];

        for (const candidate of ['queued-ice-1', 'queued-ice-2']) {
            await peer.handleSignal(QRtcSignalingType.IceCandidate, {
                description: null,
                candidate: {
                    candidate,
                },
            });
        }
        await (peer as any).signalingChain;

        expect(pc.addIceCandidate).not.toHaveBeenCalled();
        expect(peer.readDiagnostics()).toMatchObject({
            inboundIceCandidateCount: 2,
            queuedIceCandidateCount: 2,
            pendingIceCandidateQueueLength: 2,
        });
        expect((peer as any).status.iceCandidateQueue).toEqual([
            {
                candidate: 'queued-ice-1',
            },
            {
                candidate: 'queued-ice-2',
            },
        ]);

        await peer.handleSignal(QRtcSignalingType.Offer, {
            description: {
                type: 'offer',
                sdp: 'remote-offer',
            },
            candidate: null,
        });
        await (peer as any).signalingChain;

        expect(pc.setRemoteDescription).toHaveBeenCalledWith({
            type: 'offer',
            sdp: 'remote-offer',
        });
        expect(pc.addIceCandidate).toHaveBeenNthCalledWith(1, {
            candidate: 'queued-ice-1',
        });
        expect(pc.addIceCandidate).toHaveBeenNthCalledWith(2, {
            candidate: 'queued-ice-2',
        });
        expect((peer as any).status.iceCandidateQueue).toEqual([]);
        expect(peer.readDiagnostics()).toMatchObject({
            inboundOfferCount: 1,
            outboundAnswerCount: 1,
            addedIceCandidateCount: 2,
            flushedIceCandidateCount: 2,
            pendingIceCandidateQueueLength: 0,
        });
        expect(signaler.send).toHaveBeenLastCalledWith({
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'self',
            toId: 'peer-1',
            sessionId: 'self',
            token: 'token-1',
            signalType: 'Answer',
            payload: {
                description: {
                    type: 'answer',
                    sdp: 'answer-sdp',
                },
                candidate: null,
            },
        });
    });

    it('ignores stale answers without clearing negotiation collision flags', async () => {
        vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);

        const signaler = {
            send: vi.fn(async () => {
            }),
        };
        const peer = new QRtcPeerConnection(
            signaler as never,
            createPeerInput(true),
        );

        peer.connect();

        const pc = FakeRTCPeerConnection.instances[0];
        pc.signalingState = 'stable';
        (peer as any).status.makingOffer = true;
        (peer as any).status.ignoreOffer = true;

        await peer.handleSignal(QRtcSignalingType.Answer, {
            description: {
                type: 'answer',
                sdp: 'stale-answer',
            },
            candidate: null,
        });
        await (peer as any).signalingChain;

        expect(pc.setRemoteDescription).not.toHaveBeenCalled();
        expect((peer as any).status.makingOffer).toBe(true);
        expect((peer as any).status.ignoreOffer).toBe(true);
        expect(peer.readDiagnostics()).toMatchObject({
            inboundAnswerCount: 1,
            staleAnswerIgnoredCount: 1,
        });
    });

    it('ignores offer collisions when impolite and retries with ICE restart on failure', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);

        const signaler = {
            send: vi.fn(async () => {
            }),
        };
        const peer = new QRtcPeerConnection(
            signaler as never,
            createPeerInput(false),
        );

        peer.connect();

        const pc = FakeRTCPeerConnection.instances[0];
        (peer as any).status.makingOffer = true;
        pc.signalingState = 'have-local-offer';

        await peer.handleSignal(QRtcSignalingType.Offer, {
            description: {
                type: 'offer',
                sdp: 'colliding-offer',
            },
            candidate: null,
        });
        await (peer as any).signalingChain;

        expect(pc.setRemoteDescription).not.toHaveBeenCalled();
        expect(peer.readDiagnostics()).toMatchObject({
            inboundOfferCount: 1,
            offerCollisionCount: 1,
            ignoredOfferCollisionCount: 1,
        });

        await peer.handleReconnect();
        await peer.handleReconnect();
        expect((peer as any).status.reconnectAttempts).toBe(1);
        expect(peer.readDiagnostics()).toMatchObject({
            reconnectAttemptCount: 1,
            reconnectTimerAlreadyActiveCount: 1,
            hasReconnectTimer: true,
        });

        pc.connectionState = 'failed';
        await vi.advanceTimersByTimeAsync(2_000);

        expect(pc.restartIce).toHaveBeenCalledOnce();
        expect(peer.readDiagnostics()).toMatchObject({
            iceRestartCount: 1,
            iceRestartSkippedConnectedCount: 0,
            hasReconnectTimer: false,
        });

        (peer as any).status.reconnectAttempts = 5;
        await peer.handleReconnect();

        expect(peer.status.pc).toBeUndefined();
        expect(peer.isReadyToConnect()).toBe(true);
        expect(peer.readDiagnostics()).toMatchObject({
            reconnectExhaustedCount: 1,
            resetCount: 1,
            closedPeerConnectionCount: 1,
        });
    });

    it('cleans up peer connection handlers and listeners on reset', () => {
        vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);

        const peer = new QRtcPeerConnection(
            {
                send: vi.fn(async () => {
                }),
            } as never,
            createPeerInput(true),
        );

        peer.connect();

        const pc = FakeRTCPeerConnection.instances[0];
        expect(pc.listenerCount('icegatheringstatechange')).toBe(1);

        peer.reset();

        expect(pc.close).toHaveBeenCalledOnce();
        expect(pc.listenerCount('icegatheringstatechange')).toBe(0);
        expect(pc.onnegotiationneeded).toBeNull();
        expect(pc.onicecandidate).toBeNull();
        expect(pc.ondatachannel).toBeNull();
        expect(pc.ontrack).toBeNull();
        expect(pc.oniceconnectionstatechange).toBeNull();
        expect(pc.onsignalingstatechange).toBeNull();
        expect(pc.onconnectionstatechange).toBeNull();
    });

    it('coalesces repeated disconnected events into one reconnect timer', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);

        const peer = new QRtcPeerConnection(
            {
                send: vi.fn(async () => {
                }),
            } as never,
            createPeerInput(true),
        );

        peer.connect();

        const pc = FakeRTCPeerConnection.instances[0];
        pc.connectionState = 'disconnected';
        pc.onconnectionstatechange?.();
        pc.onconnectionstatechange?.();

        expect(peer.readDiagnostics()).toMatchObject({
            disconnectTimerScheduledCount: 1,
            disconnectTimerAlreadyActiveCount: 1,
            disconnectTimerClearedCount: 0,
            disconnectTimerFiredCount: 0,
        });

        pc.connectionState = 'connected';
        pc.onconnectionstatechange?.();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(peer.readDiagnostics()).toMatchObject({
            disconnectTimerScheduledCount: 1,
            disconnectTimerAlreadyActiveCount: 1,
            disconnectTimerClearedCount: 1,
            disconnectTimerFiredCount: 0,
            reconnectAttemptCount: 0,
        });
    });

    it('adds and replaces local tracks and toggles media state', async () => {
        vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);

        const signaler = {
            send: vi.fn(async () => {
            }),
        };
        const peer = new QRtcPeerConnection(
            signaler as never,
            createPeerInput(true),
        );

        peer.connect();

        const pc = FakeRTCPeerConnection.instances[0];
        const firstAudio = createFakeTrack('audio');
        const firstVideo = createFakeTrack('video');
        const firstStream = createFakeStream('local-1', [firstAudio, firstVideo]);

        await peer.setLocalMediaStream(firstStream as never);

        expect(pc.addTrack).toHaveBeenCalledTimes(2);

        const secondAudio = createFakeTrack('audio');
        const secondVideo = createFakeTrack('video');
        const secondStream = createFakeStream('local-2', [
            secondAudio,
            secondVideo,
        ]);

        await peer.setLocalMediaStream(secondStream as never);

        const audioSender = peer.status.localSenders.get('audio');
        const videoSender = peer.status.localSenders.get('video');

        expect(audioSender?.replaceTrack).toHaveBeenCalledWith(secondAudio);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(secondVideo);

        peer.setLocalAudioEnabled(false);
        peer.setLocalVideoEnabled(false);
        peer.stopLocalMedia('audio');

        expect(secondAudio.enabled).toBe(false);
        expect(secondVideo.enabled).toBe(false);
        expect(secondAudio.stop).toHaveBeenCalledOnce();
        expect(secondVideo.stop).not.toHaveBeenCalled();
    });
});

class FakeRTCDataChannel {
    public readonly label: string;

    constructor(label: string) {
        this.label = label;
    }
}

class FakeRTCPeerConnection {
    static readonly instances: FakeRTCPeerConnection[] = [];

    connectionState:
        | 'new'
        | 'connecting'
        | 'connected'
        | 'disconnected'
        | 'failed'
        | 'closed' = 'new';
    signalingState:
        | 'stable'
        | 'have-local-offer'
        | 'have-remote-offer'
        | 'closed' = 'stable';
    iceConnectionState: RTCIceConnectionState = 'new';
    iceGatheringState: RTCIceGatheringState = 'new';
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;

    onnegotiationneeded: (() => Promise<void>) | null = null;
    onicecandidate:
        | ((event: { candidate: RTCIceCandidateInit | null }) => Promise<void>)
        | null = null;
    ondatachannel: ((event: RTCDataChannelEvent) => Promise<void>) | null = null;
    ontrack: ((event: RTCTrackEvent) => Promise<void>) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    onsignalingstatechange: (() => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;

    readonly addTrack = vi.fn((track: MediaStreamTrack, _stream: MediaStream) => {
        const sender = {
            track,
            replaceTrack: vi.fn(async (nextTrack: MediaStreamTrack) => {
                sender.track = nextTrack;
            }),
            getParameters: vi.fn(() => ({})),
            setParameters: vi.fn(async () => {
            }),
        };

        return sender as unknown as RTCRtpSender;
    });
    readonly addIceCandidate = vi.fn(async () => {
    });
    readonly restartIce = vi.fn(() => {
    });
    readonly close = vi.fn(() => {
        this.connectionState = 'closed';
    });
    readonly setRemoteDescription = vi.fn(
        async (description: RTCSessionDescriptionInit) => {
            this.remoteDescription = description;
            this.signalingState =
                description.type === 'offer' ? 'have-remote-offer' : 'stable';
        },
    );
    readonly setLocalDescription = vi.fn(
        async (description?: RTCSessionDescriptionInit) => {
            if (description) {
                this.localDescription = description;
            } else if (this.remoteDescription?.type === 'offer') {
                this.localDescription = {
                    type: 'answer',
                    sdp: 'answer-sdp',
                };
            } else {
                this.localDescription = {
                    type: 'offer',
                    sdp: 'offer-sdp',
                };
            }

            this.signalingState =
                this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable';
        },
    );

    private readonly listeners = new Map<string, Array<() => void>>();

    constructor(_configuration: RTCConfiguration) {
        FakeRTCPeerConnection.instances.push(this);
    }

    addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type);
        if (!listeners) {
            return;
        }

        const index = listeners.indexOf(listener);
        if (index >= 0) {
            listeners.splice(index, 1);
        }
        if (listeners.length === 0) {
            this.listeners.delete(type);
        }
    }

    listenerCount(type: string): number {
        return this.listeners.get(type)?.length ?? 0;
    }

    getTransceivers(): Array<{ stop: () => void }> {
        return [];
    }

    createDataChannel(label: string): RTCDataChannel {
        return new FakeRTCDataChannel(label) as never;
    }
}

function createPeerInput(isPolite: boolean) {
    return {
        sessionId: 'self',
        token: 'token-1',
        peerSessionId: 'peer-1',
        iceCandidates: {
            iceServers: [],
            expiresAtEpochMs: Date.now() + 1_000,
        },
        isPolite,
    };
}

function createFakeTrack(kind: 'audio' | 'video'): MediaStreamTrack {
    return {
        kind,
        enabled: true,
        stop: vi.fn(),
    } as never;
}

function createFakeStream(id: string, tracks: MediaStreamTrack[]): MediaStream {
    return {
        id,
        getTracks: () => tracks,
        getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
        getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    } as never;
}
