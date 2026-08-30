import { afterEach, describe, expect, it, vi } from 'vitest';

import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/WebRtcOverlayMulticastManager.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { WebRtcConnectionService, type QRtcPeerDto } from '@shared/services/WebRtcConnectionService.ts';
import { WebRtcRxStreamerService } from '@shared/services/WebRtcRxStreamerService.ts';
import { QRtcDataChannel } from '@shared/webrtc/QRtcDataChannel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/QRtcMediaChannel.ts';
import { QRtcPeerConnection, type QRtcOnRemoteStreamCallback } from '@shared/webrtc/QRtcPeerConnection.ts';

interface MediaFixture {
    readonly service: WebRtcRxStreamerService;
    readonly peer: QRtcPeerDto;
    readonly publishRemoteStream: QRtcOnRemoteStreamCallback;
    readonly attachedStreams: MediaStream[];
    readonly stoppedMediaKinds: string[];
}

describe('WebRtcRxStreamerService media lifecycle', () => {
    afterEach(() => vi.restoreAllMocks());

    it('hydrates new peers with cached media settings and publishes remote streams', async () => {
        const fixture = createMediaFixture();
        const localStream = new EmptyMediaStream('local-1');
        const policy = { maxVideoBitrateBps: 120_000, maxAudioBitrateBps: 48_000 };
        const received: MediaStream[] = [];
        fixture.service.onRemoteStreamDo('remote', async (_peerId, stream) => {
            received.push(stream);
        });

        await fixture.service.setLocalMediaStream(localStream);
        fixture.service.setLocalAudioEnabled(true);
        fixture.service.setLocalVideoEnabled(false);
        fixture.service.setMediaPolicy(policy);
        fixture.service.addPeer(fixture.peer);

        await vi.waitFor(() => expect(fixture.peer.media.status.localVideoEnabled).toBe(false));
        expect(fixture.peer.connection.status.mediaPolicy).toEqual(policy);
        expect(fixture.attachedStreams).toEqual([localStream]);
        expect(fixture.peer.media.status.localAudioEnabled).toBe(true);
        const remoteStream = new EmptyMediaStream('remote-1');
        await fixture.publishRemoteStream(remoteStream, new Event('track') as RTCTrackEvent);
        expect(received).toEqual([remoteStream]);
    });

    it('updates existing peers and stops publishing their remote streams after removal', async () => {
        const fixture = createMediaFixture();
        fixture.service.addPeer(fixture.peer);
        const localStream = new EmptyMediaStream('local-2');
        const policy = { preferredVideoCodecs: ['video/VP8'] };
        const received: MediaStream[] = [];
        fixture.service.onRemoteStreamDo('remote', async (_peerId, stream) => {
            received.push(stream);
        });

        await fixture.service.setLocalMediaStream(localStream);
        fixture.service.setLocalAudioEnabled(true);
        fixture.service.setLocalVideoEnabled(true);
        fixture.service.stopLocalMedia('video');
        fixture.service.setMediaPolicy(policy);

        expect(fixture.attachedStreams).toEqual([localStream]);
        expect(fixture.peer.media.status.localAudioEnabled).toBe(true);
        expect(fixture.peer.media.status.localVideoEnabled).toBe(true);
        expect(fixture.stoppedMediaKinds).toEqual(['video']);
        expect(fixture.peer.connection.status.mediaPolicy).toEqual(policy);
        fixture.service.removePeer(fixture.peer);
        await fixture.publishRemoteStream(new EmptyMediaStream('removed-remote'), new Event('track') as RTCTrackEvent);
        expect(received).toEqual([]);
    });
});

function createMediaFixture(): MediaFixture {
    const signaler = { send: async () => undefined, connect: async () => undefined };
    const iceCandidates = { iceServers: [], expiresAtEpochMs: 60_000 };
    const connection = new QRtcPeerConnection(signaler, {
        sessionId: 'self',
        peerSessionId: 'peer-1',
        token: 'test-token',
        iceCandidates,
        isPolite: false
    });
    const channel = new QRtcDataChannel(connection, { peerId: 'peer-1', dataChannelName: 'test' });
    const media = new QRtcMediaChannel(connection, { peerId: 'peer-1' });
    const subscription = vi.spyOn(connection, 'onRemoteStreamDo');
    media.connect();
    const publishRemoteStream = subscription.mock.calls[0]?.[1];
    if (!publishRemoteStream) {
        throw new Error('Expected media subscription on the peer event port');
    }
    const attachedStreams: MediaStream[] = [];
    const stoppedMediaKinds: string[] = [];
    vi.spyOn(connection, 'setLocalMediaStream').mockImplementation(async (stream) => {
        attachedStreams.push(stream);
    });
    vi.spyOn(connection, 'stopLocalMedia').mockImplementation((kind) => {
        stoppedMediaKinds.push(kind);
    });
    const connectionService = new WebRtcConnectionService(signaler, {
        sessionId: 'self',
        token: 'test-token',
        iceCandidates,
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc-signaling'
    });
    const multicast = new WebRtcOverlayMulticastManager(
        new InMemoryQueueBox(new Map()),
        connectionService,
        new LatestRepository(),
        new LatestRepository(),
        () => {
            throw new Error('Media control must not construct multicast messages');
        }
    );
    const service = new WebRtcRxStreamerService(new InMemoryQueueBox(new Map()), multicast, { sessionId: 'self' });
    service.setRttReportingPeerIds([]);
    return {
        service,
        peer: { peerId: 'peer-1', connection, channel, channels: new Map([['reliable', channel]]), media },
        publishRemoteStream,
        attachedStreams,
        stoppedMediaKinds
    };
}

class EmptyMediaStream extends EventTarget implements MediaStream {
    readonly active = true;
    readonly id: string;
    onaddtrack: MediaStream['onaddtrack'] = null;
    onremovetrack: MediaStream['onremovetrack'] = null;

    constructor(id: string) {
        super();
        this.id = id;
    }

    getTracks(): MediaStreamTrack[] {
        return [];
    }
    getAudioTracks(): MediaStreamTrack[] {
        return [];
    }
    getVideoTracks(): MediaStreamTrack[] {
        return [];
    }
    getTrackById(_id: string): null {
        return null;
    }
    clone(): MediaStream {
        return new EmptyMediaStream(this.id);
    }
    addTrack(_track: MediaStreamTrack): void {
        throw new Error('This media fixture has no native tracks');
    }
    removeTrack(_track: MediaStreamTrack): void {
        throw new Error('This media fixture has no native tracks');
    }
}
