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

        await peer.handleSignal(QRtcSignalingType.IceCandidate, {
            description: null,
            candidate: {
                candidate: 'queued-ice',
            },
        });
        await (peer as any).signalingChain;

        expect(pc.addIceCandidate).not.toHaveBeenCalled();
        expect((peer as any).status.iceCandidateQueue).toEqual([
            {
                candidate: 'queued-ice',
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
        expect(pc.addIceCandidate).toHaveBeenCalledWith({
            candidate: 'queued-ice',
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

        await peer.handleReconnect();
        expect((peer as any).status.reconnectAttempts).toBe(1);

        pc.connectionState = 'failed';
        await vi.advanceTimersByTimeAsync(2_000);

        expect(pc.restartIce).toHaveBeenCalledOnce();

        (peer as any).status.reconnectAttempts = 5;
        await peer.handleReconnect();

        expect(peer.status.pc).toBeUndefined();
        expect(peer.isReadyToConnect()).toBe(true);
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
    constructor(public readonly label: string) {
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
