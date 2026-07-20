import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import { readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { pairKey } from '@shared/repository/rtt-repository.ts';
import { selectRttReportingPeers } from '@shared/rtc/rtt-reporting-policy.ts';

export type RtcRttAcceptanceReason =
    | 'accepted'
    | 'invalid-rtt'
    | 'self-pair'
    | 'sender-mismatch'
    | 'not-reporting-edge'
    | 'no-shared-active-group'
    | 'over-degree';

export type RtcRttAcceptanceResult = Readonly<{
    accepted: boolean;
    reason: RtcRttAcceptanceReason;
    affectedGroups: readonly GroupSnapshot[];
}>;

export function filterRtcRttMeasurementsForGroup(input: {
    readonly group: GroupSnapshot;
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly overlaySnapshot?: RallarOverlayTopologySnapshot;
    readonly degreeLimit: number;
}): readonly RttMeasurementInfo[] {
    if (input.group.group.status !== 'active' || input.rttMeasurements.length === 0) {
        return [];
    }

    return input.rttMeasurements.filter((rtt) =>
        groupIncludesPair(input.group, rtt.sessionIdFrom, rtt.sessionIdTo) &&
        isReportingPairForGroup(
            input.group,
            rtt,
            input.overlaySnapshot,
            input.degreeLimit,
        )
    );
}

export function evaluateRtcRttMeasurement(input: {
    readonly rtt: RttMeasurementInfo;
    readonly alSenderId: string;
    readonly requestedAtEpochMs: number;
    readonly candidateGroups: readonly GroupSnapshot[];
    readonly overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
    readonly existingMeasurements: readonly RttMeasurementInfo[];
    readonly degreeLimit: number;
}): RtcRttAcceptanceResult {
    const { rtt } = input;
    if (
        typeof rtt.rttMs !== 'number' ||
        !Number.isFinite(rtt.rttMs) ||
        rtt.rttMs <= 0
    ) {
        return rejected('invalid-rtt');
    }

    if (rtt.sessionIdFrom === rtt.sessionIdTo) {
        return rejected('self-pair');
    }

    if (input.alSenderId !== rtt.sessionIdFrom) {
        return rejected('sender-mismatch');
    }

    const sharedActiveGroups = input.candidateGroups.filter((group) =>
        group.group.status === 'active' &&
        (group.group.expiresAtEpochMs === undefined ||
            group.group.expiresAtEpochMs > input.requestedAtEpochMs) &&
        groupIncludesLivePairAt(
            group,
            rtt.sessionIdFrom,
            rtt.sessionIdTo,
            input.requestedAtEpochMs,
        )
    );

    if (sharedActiveGroups.length === 0) {
        return rejected('no-shared-active-group');
    }

    if (
        sharedActiveGroups.some((group) =>
            !isReportingPairForGroup(
                group,
                rtt,
                input.overlaySnapshotsByGroupKey.get(toWebRtcGroupKey(group.group)),
                input.degreeLimit,
            )
        )
    ) {
        return rejected('not-reporting-edge', sharedActiveGroups);
    }

    if (exceedsEndpointDegree(rtt, input.existingMeasurements, input.degreeLimit)) {
        return rejected('over-degree', sharedActiveGroups);
    }

    return {
        accepted: true,
        reason: 'accepted',
        affectedGroups: sharedActiveGroups,
    };
}

function rejected(
    reason: Exclude<RtcRttAcceptanceReason, 'accepted'>,
    affectedGroups: readonly GroupSnapshot[] = [],
): RtcRttAcceptanceResult {
    return {
        accepted: false,
        reason,
        affectedGroups,
    };
}

function groupIncludesPair(
    group: GroupSnapshot,
    sessionIdFrom: string,
    sessionIdTo: string,
): boolean {
    const memberIds = new Set(readGroupMemberSessionIds(group));
    return memberIds.has(sessionIdFrom) && memberIds.has(sessionIdTo);
}

function groupIncludesLivePairAt(
    group: GroupSnapshot,
    sessionIdFrom: string,
    sessionIdTo: string,
    requestedAtEpochMs: number,
): boolean {
    const liveSessionIds = new Set(
        group.activeSessions
            .filter((session) =>
                session.connectedAtEpochMs <= requestedAtEpochMs &&
                session.expiresAtEpochMs > requestedAtEpochMs
            )
            .map((session) => session.sessionId),
    );
    return liveSessionIds.has(sessionIdFrom) && liveSessionIds.has(sessionIdTo);
}

function isReportingPairForGroup(
    group: GroupSnapshot,
    rtt: RttMeasurementInfo,
    overlay: RallarOverlayTopologySnapshot | undefined,
    degreeLimit: number,
): boolean {
    const activePeerSessionIds = readGroupMemberSessionIds(group);
    const groupKey = toWebRtcGroupKey(group.group);
    const fromSelection = selectRttReportingPeers({
        localSessionId: rtt.sessionIdFrom,
        degreeLimit,
        overlayNextHopSessionIds:
            overlay?.nextHopsBySessionId[rtt.sessionIdFrom] ?? [],
        activePeerSessionIds,
        groupKey,
    });
    const toSelection = selectRttReportingPeers({
        localSessionId: rtt.sessionIdTo,
        degreeLimit,
        overlayNextHopSessionIds:
            overlay?.nextHopsBySessionId[rtt.sessionIdTo] ?? [],
        activePeerSessionIds,
        groupKey,
    });

    return fromSelection.selectedPeerIds.includes(rtt.sessionIdTo) ||
        toSelection.selectedPeerIds.includes(rtt.sessionIdFrom);
}

function exceedsEndpointDegree(
    rtt: RttMeasurementInfo,
    existingMeasurements: readonly RttMeasurementInfo[],
    degreeLimit: number,
): boolean {
    const rttPairKey = pairKey(rtt.sessionIdFrom, rtt.sessionIdTo);
    const peerIdsByEndpoint = new Map<string, Set<string>>([
        [rtt.sessionIdFrom, new Set()],
        [rtt.sessionIdTo, new Set()],
    ]);

    for (const measurement of existingMeasurements) {
        if (
            pairKey(measurement.sessionIdFrom, measurement.sessionIdTo) ===
                rttPairKey
        ) {
            continue;
        }

        addEndpointPeer(peerIdsByEndpoint, measurement.sessionIdFrom, measurement.sessionIdTo);
        addEndpointPeer(peerIdsByEndpoint, measurement.sessionIdTo, measurement.sessionIdFrom);
    }

    return (peerIdsByEndpoint.get(rtt.sessionIdFrom)?.size ?? 0) >= degreeLimit ||
        (peerIdsByEndpoint.get(rtt.sessionIdTo)?.size ?? 0) >= degreeLimit;
}

function addEndpointPeer(
    peerIdsByEndpoint: Map<string, Set<string>>,
    endpointId: string,
    peerId: string,
): void {
    if (endpointId === peerId) {
        return;
    }
    peerIdsByEndpoint.get(endpointId)?.add(peerId);
}
