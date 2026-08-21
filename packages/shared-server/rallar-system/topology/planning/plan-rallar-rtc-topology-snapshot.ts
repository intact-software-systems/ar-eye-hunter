import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    readGroupCausalRevision,
    readGroupCreatedAtEpochMs,
    readGroupCreatedByPrincipalId,
    readGroupDisplayName,
    readGroupMemberSessionIds
} from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import { compareRtcTopologyIdentifiers } from '../../rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from '../../rtc-topology-semantic-equality.ts';
import type { RallarRtcTopologyUpdateResult } from '../../services/rallar-rtc-topology-service.ts';

export function planRallarRtcTopologySnapshot(
    input: Readonly<{
        group: GroupSnapshot;
        previous?: RallarOverlayTopologySnapshot;
        topology: RallarRtcTopologyKind;
        nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
        degreeLimit: number;
        nowEpochMs: number;
    }>
): RallarRtcTopologyUpdateResult {
    const activeSessionIds = [...readGroupMemberSessionIds(input.group)].sort(
        compareRtcTopologyIdentifiers
    );
    const name = readGroupDisplayName(input.group);
    const changed = input.previous === undefined ||
        input.previous.topology !== input.topology ||
        input.previous.name !== name ||
        input.previous.degreeLimit !== input.degreeLimit ||
        !isSameNextHopMap(input.previous.nextHopsBySessionId, input.nextHopsBySessionId);
    const candidate: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision: readGroupCausalRevision(input.group),
        state: 'active',
        overlayId: toScopedOverlayId(input.group.group),
        groupRef: canonicalGroupRef(input.group.group),
        name,
        topology: input.topology,
        activeSessionIds,
        nextHopsBySessionId: input.nextHopsBySessionId,
        degreeLimit: input.degreeLimit,
        version: changed ? (input.previous?.version ?? 0) + 1 : input.previous.version,
        createdByClientId: readGroupCreatedByPrincipalId(input.group),
        createdAtEpochMs: input.previous?.createdAtEpochMs ?? readGroupCreatedAtEpochMs(input.group),
        updatedAtEpochMs: changed ? input.nowEpochMs : input.previous.updatedAtEpochMs
    };
    const snapshot = input.previous && rtcTopologySemanticEqual(candidate, input.previous)
        ? input.previous
        : candidate;
    return { snapshot, changed, previous: input.previous ?? null };
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId
    };
}

function isSameNextHopMap(
    left: Readonly<Record<string, readonly string[]>>,
    right: Readonly<Record<string, readonly string[]>>
): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    for (let i = 0; i < leftKeys.length; i++) {
        const key = leftKeys[i];
        if (key !== rightKeys[i]) {
            return false;
        }

        if (!sameStringArray(left[key], right[key])) {
            return false;
        }
    }

    return true;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
