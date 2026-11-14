import { toError } from '@shared/resilience/to-error.ts';
import type { ConnectionCapInboundVerdict } from '@shared/services/group-dial/compute-connection-cap-spend.ts';
import type { WebRtcGroupPeerLedger } from '@shared/services/group-dial/web-rtc-group-peer-ledger.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import type { WebRtcGroupManagerOptions } from '@shared/services/webrtc-group-manager-contracts.ts';

/** Why a peer is refused until this browser adopts the layout that names it; adoption releases its held offers. */
export const BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON = 'stage-layout-mismatch';
/**
 * Why an early-dial peer's offer waits: no connection slot is free for it. The end of every reconcile pass releases
 * these holds, so a slot freed by a closed peer or an ended grace admits the held offer at once.
 */
const BROWSER_RTC_EARLY_DIAL_CAPACITY_REASON = 'early-dial-capacity';

/** The rooms' answers the browser's admission reads; the ledger's retention stays out of its reach. */
export type BrowserRtcPeerAdmissionLedger = Pick<
    WebRtcGroupPeerLedger,
    'isPeerDialAllowedByAnyGroup' | 'resolveInboundPeer' | 'hasClosableEarlyPeer' | 'admitInboundPeer'
>;

export function createBrowserRtcPeerAdmission(
    ledger: BrowserRtcPeerAdmissionLedger
): WebRtcConnectionService.PeerAdmission {
    return {
        decideInbound: ({ peerId }, peers) =>
            ledger.isPeerDialAllowedByAnyGroup(peerId)
                ? toInboundPeerCreationDecision(ledger.admitInboundPeer(peerId, peers))
                : { decision: 'retry', reason: BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON },
        decideInboundAtCap: ({ peerId }, peers) => toPeerCapDecision(ledger, peerId, peers),
        wouldAdmitInboundAtCap: ({ peerId }, peers) =>
            ledger.isPeerDialAllowedByAnyGroup(peerId) &&
            ledger.resolveInboundPeer(peerId, peers) === 'admitted',
        decideOutbound: ({ peerId }) =>
            ledger.isPeerDialAllowedByAnyGroup(peerId)
                ? { decision: 'allow' }
                : { decision: 'deny', reason: BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON }
    };
}

/**
 * A peer no room dials yet is held while an early peer could make room for it, so the adoption that names it releases
 * it; with no early peer it is refused. Nothing closes while it is held.
 */
function toPeerCapDecision(
    ledger: BrowserRtcPeerAdmissionLedger,
    peerId: string,
    peers: WebRtcConnectionService.ClosableAdmissionPeers
): WebRtcConnectionService.InboundPeerCreationDecision {
    if (ledger.isPeerDialAllowedByAnyGroup(peerId)) {
        return toInboundPeerCreationDecision(ledger.admitInboundPeer(peerId, peers));
    }
    return ledger.hasClosableEarlyPeer(peers)
        ? { decision: 'retry', reason: BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON }
        : { decision: 'deny', reason: BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON };
}

export function createBrowserRtcHeldOfferReleases(
    webRtcConnectionService: WebRtcConnectionService
): Pick<WebRtcGroupManagerOptions, 'onOverlayAdopted' | 'onReconcilePassEnded'> {
    return {
        onReconcilePassEnded: () => releaseEarlyDialCapacityHolds(webRtcConnectionService),
        onOverlayAdopted: () =>
            webRtcConnectionService.writeHeldInboundSignalsDueNow(BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON)
    };
}

function releaseEarlyDialCapacityHolds(webRtcConnectionService: WebRtcConnectionService): void {
    void webRtcConnectionService.writeHeldInboundSignalsDueNow(BROWSER_RTC_EARLY_DIAL_CAPACITY_REASON)
        .catch((caught) => console.error('Failed to release early-dial offers held for a slot', toError(caught)));
}

function toInboundPeerCreationDecision(
    verdict: ConnectionCapInboundVerdict
): WebRtcConnectionService.InboundPeerCreationDecision {
    switch (verdict) {
        case 'admitted':
            return { decision: 'allow' };
        case 'held':
            return { decision: 'retry', reason: BROWSER_RTC_EARLY_DIAL_CAPACITY_REASON };
        case 'refused':
            return { decision: 'deny', reason: 'max-peer-connections' };
    }
}
