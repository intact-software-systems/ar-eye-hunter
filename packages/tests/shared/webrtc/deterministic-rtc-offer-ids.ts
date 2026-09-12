import type { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

export class DeterministicRtcOfferIds implements QRtcPeerConnection.Dependencies {
    private sequence = 0;

    createOfferId(): string {
        this.sequence += 1;
        return `offer-${this.sequence}`;
    }
}
