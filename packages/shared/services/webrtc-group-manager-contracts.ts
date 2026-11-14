import { GroupId, PeerId } from '../api/api-config.ts';

export interface WebRtcGroupManagerState {
    readonly groupIds: readonly GroupId[];
    readonly desiredPeerIds: readonly PeerId[];
    readonly onlinePeerIds: readonly PeerId[];
    readonly onlineDesiredPeerIds: readonly PeerId[];
    readonly connectablePeerIds: readonly PeerId[];
    readonly peerIdsWithNoReconnectableLanes: readonly PeerId[];
    readonly peerOwners: ReadonlyMap<PeerId, readonly GroupId[]>;
}

export interface WebRtcGroupManagerOptions {
    readonly maxPeerConnections?: number;
    readonly overlayTransitionGraceMs?: number;
    readonly now?: () => number;
    readonly rttReportingDegreeLimit?: number;
    readonly onDesiredPeerIdsChanged?: (selection: WebRtcGroupPeerSelection) => void;
    /** Runs on every overlay adoption beside the reconcile it starts: what the adopted layout releases. */
    readonly onOverlayAdopted: () => Promise<void>;
    /** Ends every reconcile pass: a connection slot may have been freed by what the pass closed or saw closed. */
    readonly onReconcilePassEnded?: () => void;
}

export interface WebRtcGroupPeerSelection {
    readonly desiredPeerIds: readonly PeerId[];
    readonly rttReportingPeerIds: readonly PeerId[];
}

export interface WebRtcGroupManagerDeleteOptions {
    readonly retainConnections?: boolean;
}

export interface WebRtcRttReportingPeerOptions {
    readonly degreeLimit?: number;
}

/**
 * `commanded` is reserved for the activation design's commanded-edge
 * retention (the Phase 5 merge point); this manager only produces the first
 * two reasons. Eviction order is defined across reasons: expired entries
 * first, then `computeConnectionCapSpend`'s order, which reads `earlyDial` and
 * `retainedOrder` and never the reason.
 */
/** Which groups want each desired peer, and each group's in-flight setup bound (product decision 18). */
export interface WebRtcPeerOwnership {
    readonly groupsByPeerId: ReadonlyMap<PeerId, readonly GroupId[]>;
    readonly dialAllowedPeerIds: ReadonlySet<PeerId>;
    /** Desired peers no room wants except through an active room's published planned layout. */
    readonly earlyDialPeerIds: ReadonlySet<PeerId>;
    /** The same ownership by the scoped group key, which the bound is keyed on. */
    readonly groupKeysByPeerId: ReadonlyMap<PeerId, readonly string[]>;
    readonly maxConcurrentEdgeSetupsByGroupKey: ReadonlyMap<string, number>;
}

export type RetainedPeerConnectionReason = 'left-group' | 'overlay-transition' | 'commanded';

export interface RetainedPeerConnection {
    readonly peerId: PeerId;
    /** Group scope of a `left-group` retention; an overlay transition is not group-scoped. */
    readonly groupKey: string | null;
    readonly groupId: GroupId | null;
    readonly retainedOrder: number;
    /** The peer was wanted only through an active room's planned layout when it was retained. */
    readonly earlyDial: boolean;
    readonly reason: RetainedPeerConnectionReason;
    /** `null` retains until budget eviction; a timestamp is the grace-window expiry. */
    readonly expiresAtEpochMs: number | null;
}

export function clonePeerOwners(
    peerOwners: ReadonlyMap<PeerId, readonly GroupId[]>
): ReadonlyMap<PeerId, readonly GroupId[]> {
    const copy = new Map<PeerId, readonly GroupId[]>();
    for (const [peerId, groupIds] of peerOwners.entries()) {
        copy.set(peerId, [...groupIds]);
    }
    return copy;
}

export interface MutableWebRtcGroupManagerDiagnostics {
    reconcileRunCount: number;
    reconcileAwaitedInFlightCount: number;
    reconcileCoalescedRerunCount: number;
    lastDesiredPeerCount: number;
    connectAttemptCount: number;
    connectFailureCount: number;
    connectDeferredBudgetCount: number;
    connectDeferredPacingCount: number;
    disconnectCount: number;
    retainedCreatedCount: number;
    retainedExpiredCount: number;
    retainedEvictionCount: number;
}

export type WebRtcGroupManagerDiagnostics = Readonly<MutableWebRtcGroupManagerDiagnostics>;

export function emptyGroupManagerDiagnostics(): MutableWebRtcGroupManagerDiagnostics {
    return {
        reconcileRunCount: 0,
        reconcileAwaitedInFlightCount: 0,
        reconcileCoalescedRerunCount: 0,
        lastDesiredPeerCount: 0,
        connectAttemptCount: 0,
        connectFailureCount: 0,
        connectDeferredBudgetCount: 0,
        connectDeferredPacingCount: 0,
        disconnectCount: 0,
        retainedCreatedCount: 0,
        retainedExpiredCount: 0,
        retainedEvictionCount: 0
    };
}
