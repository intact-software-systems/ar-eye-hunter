import type { QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcMediaChannel } from '@shared/webrtc/qrtc-media-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

export interface BrowserRtcPeerTestInput {
    readonly peerId: string;
    readonly status?: Partial<QRtcPeerConnection.Status>;
    readonly channels: readonly (readonly [string, Partial<QRtcDataChannel>])[];
}

/** Facade tests replace selected public operations on fully constructed RTC owners. */
export function createBrowserRtcPeerTestDouble(input: BrowserRtcPeerTestInput): QRtcPeerDto {
    const connection = new QRtcPeerConnection({ send: async () => undefined }, {
        sessionId: 'session-1',
        peerSessionId: input.peerId,
        token: 'fixture-token',
        isPolite: false,
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 }
    });
    Object.assign(connection.status, input.status);
    const channels = new Map(input.channels.map(([laneId, overrides]) =>
        [
            laneId,
            Object.assign(new QRtcDataChannel(connection, { peerId: input.peerId, dataChannelName: laneId }), overrides)
        ] as const
    ));
    const channel = channels.get('reliable') ?? channels.values().next().value ??
        new QRtcDataChannel(connection, { peerId: input.peerId, dataChannelName: 'reliable' });
    return { peerId: input.peerId, connection, channel, channels, media: new QRtcMediaChannel(connection, { peerId: input.peerId }) };
}
