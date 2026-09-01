import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaSessionState, QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import {
    SimulatedMediaStream,
    SimulatedMediaTrack,
    SimulatedNativeMediaPeerConnection,
    SimulatedRtcTrackEvent
} from './native-rtc-media-fixture.ts';

const peers: QRtcPeerConnection[] = [];

beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', SimulatedNativeMediaPeerConnection);
});

afterEach(() => {
    for (const peer of peers.splice(0)) {
        peer.reset();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('QRtcMediaChannel', () => {
    it('delivers native tracks once across repeated connect and unsubscribes on reset', async () => {
        const { peerConnection, native, channel } = createNativeMediaChannelFixture();
        const deliveredTracks: MediaStreamTrack[] = [];
        const deliveredStreams: MediaStream[] = [];
        channel.onTrackDo('track', async (event) => {
            deliveredTracks.push(event.track);
        });
        channel.onRemoteStreamDo('stream', async (stream) => {
            deliveredStreams.push(stream);
        });
        channel.connect();
        channel.connect();
        expect(channel.status.state).toBe(MediaSessionState.Connecting);

        const track = new SimulatedMediaTrack('video');
        const stream = new SimulatedMediaStream('remote-1', [track]);
        await native.ontrack?.call(native, new SimulatedRtcTrackEvent(track, stream));

        expect(channel.getRemoteStreams()).toEqual([stream]);
        expect(deliveredStreams).toEqual([stream]);
        expect(deliveredTracks).toEqual([track]);
        channel.reset();
        const laterStream = new SimulatedMediaStream('remote-2', [track]);
        await native.ontrack?.call(native, new SimulatedRtcTrackEvent(track, laterStream));

        expect([...peerConnection.status.remoteStreams.values()]).toEqual([stream, laterStream]);
        expect(channel.status.state).toBe(MediaSessionState.Idle);
        expect(channel.isReadyToConnect()).toBe(true);
        expect(channel.getRemoteStreams()).toEqual([]);
        expect(deliveredStreams).toEqual([stream]);
        expect(deliveredTracks).toEqual([track]);
    });

    it('applies current audio/video toggles to native senders and stops local tracks', async () => {
        const { native, channel } = createNativeMediaChannelFixture();
        native.setConnected();
        channel.connect();
        expect(channel.isOpen()).toBe(true);
        expect(channel.isReadyToConnect()).toBe(false);

        channel.setLocalAudioEnabled(false);
        channel.setLocalVideoEnabled(true);
        const audio = new SimulatedMediaTrack('audio');
        const video = new SimulatedMediaTrack('video');
        const stream = new SimulatedMediaStream('local-1', [audio, video]);
        await channel.setLocalMediaStream(stream);

        expect(native.getSenders().map((sender) => sender.track)).toEqual([audio, video]);
        expect(audio.enabled).toBe(false);
        expect(video.enabled).toBe(true);
        await channel.setParameters(stream, true, false);
        expect(audio.enabled).toBe(true);
        expect(video.enabled).toBe(false);
        expect(channel.status.localAudioEnabled).toBe(true);
        expect(channel.status.localVideoEnabled).toBe(false);

        channel.stopLocalMedia('all');
        expect(audio.readyState).toBe('ended');
        expect(video.readyState).toBe('ended');
    });

    it('isolates rejected media callbacks and removes each subscription by public ID', async () => {
        const { native, channel } = createNativeMediaChannelFixture();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const delivered: string[] = [];
        channel.onRemoteStreamDo('rejected', async () => {
            throw new Error('Rejected media observer');
        });
        channel.onRemoteStreamDo('accepted', async (stream) => {
            delivered.push(stream.id);
        });
        channel.onTrackDo('removed', async () => {
            delivered.push('removed');
        });
        expect(channel.removeOnTrackCallbackById('removed')).toBe(true);
        channel.connect();
        const track = new SimulatedMediaTrack('audio');
        await native.ontrack?.call(native, new SimulatedRtcTrackEvent(track, new SimulatedMediaStream('first', [track])));
        expect(delivered).toEqual(['first']);
        expect(channel.removeOnRemoteStreamCallbackById('accepted')).toBe(true);
        channel.clearCallbacks();
        await native.ontrack?.call(native, new SimulatedRtcTrackEvent(track, new SimulatedMediaStream('second', [track])));
        expect(delivered).toEqual(['first']);
        expect(channel.getRemoteStreams().map((stream) => stream.id)).toEqual(['first', 'second']);
    });
});

interface NativeMediaChannelFixture {
    readonly peerConnection: QRtcPeerConnection;
    readonly native: SimulatedNativeMediaPeerConnection;
    readonly channel: QRtcMediaChannel;
}

function createNativeMediaChannelFixture(): NativeMediaChannelFixture {
    const peerConnection = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'self',
        token: 'fixture-token',
        peerSessionId: 'peer-1',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        isPolite: false
    });
    peerConnection.connect();
    peers.push(peerConnection);
    const native = peerConnection.status.pc;
    if (!(native instanceof SimulatedNativeMediaPeerConnection)) {
        throw new Error('Expected the installed native media fixture');
    }
    const channel = new QRtcMediaChannel(peerConnection, { peerId: 'peer-1' });
    return { peerConnection, native, channel };
}
