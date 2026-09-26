import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import {
    SimulatedMediaStream,
    SimulatedMediaTrack,
    SimulatedNativeMediaPeerConnection
} from '../native-rtc-media-fixture.ts';
import { DeterministicRtcOfferIds } from './deterministic-rtc-offer-ids.ts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('creates missing transceivers and applies only supported codecs in requested priority', () => {
    const { peer, native } = createMediaPolicyFixture();
    peer.applyMediaPolicy({
        preferredAudioCodecs: ['audio/opus'],
        preferredVideoCodecs: ['video/H264', 'video/VP8', 'video/not-supported']
    });
    peer.applyMediaPolicy({ preferredVideoCodecs: ['video/H264', 'video/VP8'] });

    expect(
        native.getTransceivers().map((transceiver) => ({
            kind: transceiver.receiver.track.kind,
            direction: transceiver.direction,
            codecs: transceiver.codecs.map((codec) => codec.mimeType)
        }))
    ).toEqual([
        { kind: 'audio', direction: 'sendrecv', codecs: ['audio/opus'] },
        { kind: 'video', direction: 'sendrecv', codecs: ['video/H264', 'video/VP8'] }
    ]);
});

it('applies video adaptation and audio bitrate to their native senders', async () => {
    const { peer, native } = createMediaPolicyFixture();
    await peer.setLocalMediaStream(
        new SimulatedMediaStream('local', [
            new SimulatedMediaTrack('audio'),
            new SimulatedMediaTrack('video')
        ])
    );
    peer.applyMediaPolicy({
        maxAudioBitrateBps: 32_000,
        maxVideoBitrateBps: 700_000,
        maxVideoFramerate: 24,
        scaleResolutionDownBy: 2,
        degradationPreference: 'maintain-framerate'
    });

    expect(native.getSenders().map((sender) => sender.getParameters())).toMatchObject([
        { encodings: [{ maxBitrate: 32_000 }] },
        {
            encodings: [{ maxBitrate: 700_000, maxFramerate: 24, scaleResolutionDownBy: 2 }],
            degradationPreference: 'maintain-framerate'
        }
    ]);
});

interface MediaPolicyFixture {
    readonly peer: QRtcPeerConnection;
    readonly native: SimulatedNativeMediaPeerConnection;
}

function createMediaPolicyFixture(): MediaPolicyFixture {
    vi.stubGlobal('RTCPeerConnection', SimulatedNativeMediaPeerConnection);
    vi.stubGlobal('RTCRtpSender', {
        getCapabilities: (kind: string) => ({
            codecs: kind === 'audio'
                ? [{ mimeType: 'audio/opus', clockRate: 48_000 }]
                : [{ mimeType: 'video/VP8', clockRate: 90_000 }, { mimeType: 'video/H264', clockRate: 90_000 }],
            headerExtensions: []
        })
    });
    const peer = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'self',
        token: 'test-token',
        peerSessionId: 'remote',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        isPolite: true
    }, new DeterministicRtcOfferIds());
    onTestFinished(() => {
        peer.reset();
    });
    peer.connect();
    const native = peer.status.pc;
    if (!(native instanceof SimulatedNativeMediaPeerConnection)) {
        throw new Error('Expected native media peer');
    }
    return { peer, native };
}
