import type { PeerId } from '../../api/api-config.ts';
import { toError } from '../../resilience/to-error.ts';
import type { WebRtcConnectionService } from '../web-rtc-connection-service.ts';
import type { WebRtcGroupService } from '../web-rtc-group-service.ts';
import type {
    MutableWebRtcGroupPeerLedgerDiagnostics,
    RetainedPeerConnection
} from '../webrtc-group-manager-contracts.ts';
import { selectRetentionsEndedByDesire } from './webrtc-group-dial-policy.ts';

export namespace RetainedPeerConnections {
    export interface Config {
        readonly overlayTransitionGraceMs: number;
        readonly nowEpochMs: () => number;
        /** The group peer ledger's counters, which retention writes beside the connection cap. */
        readonly diagnostics: MutableWebRtcGroupPeerLedgerDiagnostics;
    }

    export interface LeftGroup {
        readonly group: WebRtcGroupService;
        readonly groupKey: string;
        /** The peers the group dials, which stay connected after it is left. */
        readonly targetPeerIds: readonly PeerId[];
        readonly peers: WebRtcConnectionService.AdmissionPeers;
    }
}

/** The connections kept after the rooms stopped wanting them: until a grace ends, or until the cap evicts them. */
export class RetainedPeerConnections {
    private readonly retainedPeerConnections = new Map<PeerId, RetainedPeerConnection>();
    private reconciledEarlyDialPeerIds: ReadonlySet<PeerId> = new Set();
    private retainedOrder = 0;

    private readonly overlayTransitionGraceMs: number;
    private readonly nowEpochMs: () => number;
    private readonly diagnostics: MutableWebRtcGroupPeerLedgerDiagnostics;

    constructor(config: RetainedPeerConnections.Config) {
        this.overlayTransitionGraceMs = config.overlayTransitionGraceMs;
        this.nowEpochMs = config.nowEpochMs;
        this.diagnostics = config.diagnostics;
    }

    getRetainedPeerConnections(): ReadonlyMap<PeerId, RetainedPeerConnection> {
        return this.retainedPeerConnections;
    }

    delete(peerId: PeerId): boolean {
        return this.retainedPeerConnections.delete(peerId);
    }

    clear(): void {
        this.retainedPeerConnections.clear();
    }

    setReconciledEarlyDialPeerIds(earlyDialPeerIds: ReadonlySet<PeerId>): void {
        this.reconciledEarlyDialPeerIds = earlyDialPeerIds;
    }

    /**
     * An established edge the previous overlay wanted survives a replan for
     * the grace window instead of being torn down in the same pass —
     * a flapping overlay converges to zero churn because the edge is still
     * there when the next epoch wants it back.
     */
    retainUndesiredKnownPeers(
        desiredPeerIds: Set<PeerId>,
        knownPeerIds: Set<PeerId>
    ): void {
        for (const peerId of knownPeerIds) {
            if (desiredPeerIds.has(peerId) || this.retainedPeerConnections.has(peerId)) {
                continue;
            }

            this.retainedPeerConnections.set(peerId, {
                peerId,
                groupKey: null,
                groupId: null,
                retainedOrder: this.retainedOrder++,
                earlyDial: this.reconciledEarlyDialPeerIds.has(peerId),
                reason: 'overlay-transition',
                expiresAtEpochMs: this.nowEpochMs() + this.overlayTransitionGraceMs
            });
            this.diagnostics.retainedCreatedCount += 1;
        }
    }

    disconnectExpiredRetainedPeers(
        knownPeerIds: Set<PeerId>,
        peers: WebRtcConnectionService.ClosableAdmissionPeers
    ): void {
        const now = this.nowEpochMs();
        for (const retained of Array.from(this.retainedPeerConnections.values())) {
            if (
                retained.expiresAtEpochMs === null ||
                retained.expiresAtEpochMs > now ||
                !knownPeerIds.has(retained.peerId)
            ) {
                continue;
            }

            try {
                peers.disconnectPeer(retained.peerId, { resetAttemptBudget: false });
                this.retainedPeerConnections.delete(retained.peerId);
                this.diagnostics.disconnectCount += 1;
                this.diagnostics.retainedExpiredCount += 1;
            }
            catch (error) {
                console.error(`Failed to disconnect retained peer ${retained.peerId}`, toError(error));
            }
        }
    }

    resolveEarliestRetainedExpiryAtEpochMs(): number | undefined {
        const expiries = Array.from(this.retainedPeerConnections.values())
            .map((retained) => retained.expiresAtEpochMs)
            .filter((expiresAtEpochMs): expiresAtEpochMs is number => expiresAtEpochMs !== null);
        return expiries.length === 0 ? undefined : Math.min(...expiries);
    }

    retainKnownPeersForGroup(leftGroup: RetainedPeerConnections.LeftGroup): void {
        const knownPeerIds = new Set(leftGroup.peers.knownPeerIds());
        for (const peerId of leftGroup.targetPeerIds) {
            if (!knownPeerIds.has(peerId) || this.retainedPeerConnections.has(peerId)) {
                continue;
            }

            this.retainedPeerConnections.set(peerId, {
                peerId,
                groupKey: leftGroup.groupKey,
                groupId: leftGroup.group.groupRef.groupId,
                retainedOrder: this.retainedOrder++,
                earlyDial: this.reconciledEarlyDialPeerIds.has(peerId),
                reason: 'left-group',
                expiresAtEpochMs: null
            });
        }
    }

    hasRetainedGroup(groupKey: string): boolean {
        return Array.from(this.retainedPeerConnections.values())
            .some((retained) => retained.groupKey === groupKey);
    }

    removeRetainedGroup(groupKey: string): void {
        for (const [peerId, retained] of this.retainedPeerConnections.entries()) {
            if (retained.groupKey === groupKey) {
                this.retainedPeerConnections.delete(peerId);
            }
        }
    }

    /** A replaced layout's edge that a planned layout names again stays retained, and ranked so, until its grace ends. */
    removeRetainedDesiredPeers(desiredPeerIds: Set<PeerId>, earlyDialPeerIds: ReadonlySet<PeerId>): void {
        const endedPeerIds = selectRetentionsEndedByDesire({
            desiredPeerIds,
            earlyDialPeerIds,
            retainedPeerConnections: this.retainedPeerConnections,
            nowEpochMs: this.nowEpochMs()
        });
        for (const peerId of endedPeerIds) {
            this.retainedPeerConnections.delete(peerId);
        }
    }

    removeUnknownRetainedPeers(knownPeerIds: Set<PeerId>): void {
        for (const peerId of this.retainedPeerConnections.keys()) {
            if (!knownPeerIds.has(peerId)) {
                this.retainedPeerConnections.delete(peerId);
            }
        }
    }
}
