import { MediaSessionState, QRtcMediaChannel } from '@shared/webrtc/QRtcMediaChannel.ts';
import { describe, expect, it, vi } from 'vitest';

describe('QRtcMediaChannel', () => {
    it('subscribes once, caches remote streams, and resets cleanly', async () => {
        const peerConnection = new FakePeerConnection();
        const channel = new QRtcMediaChannel(peerConnection as never, {
            peerId: 'peer-1'
        });

        const onTrack = vi.fn(async () => {
        });
        const onRemoteStream = vi.fn(async () => {
        });

        channel.onTrackDo('track', onTrack);
        channel.onRemoteStreamDo('stream', onRemoteStream);

        channel.connect();
        channel.connect();

        expect(channel.status.state).toBe(MediaSessionState.Connecting);
        expect(peerConnection.onRemoteStreamDo).toHaveBeenCalledTimes(1);
        expect(peerConnection.onTrackDo).toHaveBeenCalledTimes(1);

        const remoteStream = createMediaStream('remote-1');
        const remoteEvent = createTrackEvent(remoteStream);

        await peerConnection.emitRemoteStream(remoteStream, remoteEvent);
        await peerConnection.emitTrack(remoteEvent);

        expect(channel.getRemoteStreams()).toEqual([remoteStream]);
        expect(onRemoteStream).toHaveBeenCalledWith(remoteStream, remoteEvent);
        expect(onTrack).toHaveBeenCalledWith(remoteEvent);

        channel.reset();

        expect(channel.status.state).toBe(MediaSessionState.Idle);
        expect(channel.getRemoteStreams()).toEqual([]);
        expect(peerConnection.removeOnRemoteStreamCallbackById).toHaveBeenCalledWith(
            'peer-1:media:stream'
        );
        expect(peerConnection.removeOnTrackCallbackById).toHaveBeenCalledWith(
            'peer-1:media:track'
        );

        await peerConnection.emitRemoteStream(createMediaStream('remote-2'), remoteEvent);
        expect(onRemoteStream).toHaveBeenCalledTimes(1);
    });

    it('propagates local media state and reports openness from the peer connection', async () => {
        const peerConnection = new FakePeerConnection(true);
        const channel = new QRtcMediaChannel(peerConnection as never, {
            peerId: 'peer-1'
        });

        channel.connect();

        expect(channel.status.state).toBe(MediaSessionState.Open);
        expect(channel.isOpen()).toBe(true);
        expect(channel.isReadyToConnect()).toBe(false);

        channel.setLocalAudioEnabled(false);
        channel.setLocalVideoEnabled(true);

        const localStream = createMediaStream('local-1');
        await channel.setLocalMediaStream(localStream);
        await channel.setParameters(localStream, true, false);

        expect(peerConnection.setLocalMediaStream).toHaveBeenCalledTimes(2);
        expect(peerConnection.setLocalAudioEnabled).toHaveBeenLastCalledWith(true);
        expect(peerConnection.setLocalVideoEnabled).toHaveBeenLastCalledWith(false);
        expect(channel.status.localAudioEnabled).toBe(true);
        expect(channel.status.localVideoEnabled).toBe(false);

        channel.stopLocalMedia('all');
        expect(peerConnection.stopLocalMedia).toHaveBeenCalledWith('all');
    });
});

class FakePeerConnection {
    public readonly remoteStreamCallbacks = new Map<string, RemoteStreamCallback>();
    public readonly trackCallbacks = new Map<string, TrackCallback>();
    public readonly onRemoteStreamDo = vi.fn(
        (id: string, cb: RemoteStreamCallback) => {
            this.remoteStreamCallbacks.set(id, cb);
            return this;
        }
    );
    public readonly onTrackDo = vi.fn((id: string, cb: TrackCallback) => {
        this.trackCallbacks.set(id, cb);
        return this;
    });
    public readonly removeOnRemoteStreamCallbackById = vi.fn((id: string) => {
        return this.remoteStreamCallbacks.delete(id);
    });
    public readonly removeOnTrackCallbackById = vi.fn((id: string) => {
        return this.trackCallbacks.delete(id);
    });
    public readonly setLocalMediaStream = vi.fn(async () => {
    });
    public readonly setLocalAudioEnabled = vi.fn();
    public readonly setLocalVideoEnabled = vi.fn();
    public readonly stopLocalMedia = vi.fn();
    public readonly isOpen = vi.fn(() => this.open);

    private readonly open: boolean;

    constructor(open = false) {
        this.open = open;
    }

    async emitRemoteStream(stream: MediaStream, event: RTCTrackEvent): Promise<void> {
        for (const callback of this.remoteStreamCallbacks.values()) {
            await callback(stream, event);
        }
    }

    async emitTrack(event: RTCTrackEvent): Promise<void> {
        for (const callback of this.trackCallbacks.values()) {
            await callback(event);
        }
    }
}

type TrackCallback = (event: RTCTrackEvent) => Promise<void>;
type RemoteStreamCallback = (
    stream: MediaStream,
    event: RTCTrackEvent
) => Promise<void>;

function createMediaStream(id: string): MediaStream {
    return { id } as MediaStream;
}

function createTrackEvent(stream: MediaStream): RTCTrackEvent {
    return {
        streams: [stream]
    } as unknown as RTCTrackEvent;
}
