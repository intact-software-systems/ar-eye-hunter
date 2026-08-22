import { GroupId, PeerId } from '../api/api-config.ts';
import type { RtcGroupFormationMode } from '../rtc/group-formation-mode.ts';

export type WebRtcGroupManagerState = {
    readonly groupIds: readonly GroupId[];
    readonly desiredPeerIds: readonly PeerId[];
    readonly onlinePeerIds: readonly PeerId[];
    readonly onlineDesiredPeerIds: readonly PeerId[];
    readonly connectablePeerIds: readonly PeerId[];
    readonly peerIdsWithNoReconnectableLanes: readonly PeerId[];
    readonly peerOwners: ReadonlyMap<PeerId, readonly GroupId[]>;
};

export type WebRtcGroupManagerOptions = Readonly<{
    maxPeerConnections?: number;
    groupFormationMode?: RtcGroupFormationMode;
    overlayTransitionGraceMs?: number;
    now?: () => number;
    onDesiredPeerIdsChanged?: () => void;
}>;

export type WebRtcGroupManagerDeleteOptions = Readonly<{
    retainConnections?: boolean;
}>;

export type WebRtcRttReportingPeerOptions = Readonly<{
    degreeLimit?: number;
}>;

/**
 * `commanded` is reserved for the activation design's commanded-edge
 * retention (the Phase 5 merge point); this manager only produces the first
 * two reasons. Eviction order is defined across reasons: expired entries
 * first, then oldest `retainedOrder` regardless of reason.
 */
export type RetainedPeerConnectionReason = 'left-group' | 'overlay-transition' | 'commanded';

export type RetainedPeerConnection = Readonly<{
    peerId: PeerId;
    /** Group scope of a `left-group` retention; an overlay transition is not group-scoped. */
    groupKey: string | null;
    groupId: GroupId | null;
    retainedOrder: number;
    reason: RetainedPeerConnectionReason;
    /** `null` retains until budget eviction; a timestamp is the grace-window expiry. */
    expiresAtEpochMs: number | null;
}>;

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
        disconnectCount: 0,
        retainedCreatedCount: 0,
        retainedExpiredCount: 0,
        retainedEvictionCount: 0
    };
}
