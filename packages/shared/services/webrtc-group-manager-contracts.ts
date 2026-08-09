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
    onDesiredPeerIdsChanged?: () => void;
}>;

export type WebRtcGroupManagerDeleteOptions = Readonly<{
    retainConnections?: boolean;
}>;

export type WebRtcRttReportingPeerOptions = Readonly<{
    degreeLimit?: number;
}>;

export type RetainedPeerConnection = Readonly<{
    peerId: PeerId;
    groupKey: string;
    groupId: GroupId;
    retainedOrder: number;
}>;

export function clonePeerOwners(
    peerOwners: ReadonlyMap<PeerId, readonly GroupId[]>,
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
    lastDesiredPeerCount: number;
    connectAttemptCount: number;
    connectFailureCount: number;
    connectDeferredBudgetCount: number;
    disconnectCount: number;
    retainedEvictionCount: number;
}

export type WebRtcGroupManagerDiagnostics = Readonly<MutableWebRtcGroupManagerDiagnostics>;

export function emptyGroupManagerDiagnostics(): MutableWebRtcGroupManagerDiagnostics {
    return {
        reconcileRunCount: 0,
        reconcileAwaitedInFlightCount: 0,
        lastDesiredPeerCount: 0,
        connectAttemptCount: 0,
        connectFailureCount: 0,
        connectDeferredBudgetCount: 0,
        disconnectCount: 0,
        retainedEvictionCount: 0,
    };
}
