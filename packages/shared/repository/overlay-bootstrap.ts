import type { OverlayInfo } from '@shared/api/api-config.ts';
import { isOverlayForGroupRef, toScopedOverlayId, toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import {
    readGroupCausalRevision,
    readGroupCreatedAtEpochMs,
    readGroupCreatedByPrincipalId,
    readGroupDisplayName,
    readGroupMemberSessionIds,
    readGroupUpdatedAtEpochMs,
    readGroupVersion,
    type AnyGroupPresence
} from '@shared/api/group-client-views.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { readObservableLatestRepositoryValue } from '@shared/cache/LatestRepositoryHelpers.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { selectBootstrapPeers } from '@shared/rtc/bootstrap-peer-selection.ts';
import type { RtcGroupFormationMode } from '@shared/rtc/group-formation-mode.ts';
import { createAndSetStarOverlays, overlayRepositoryToken, setOverlayById } from './overlays-repository.ts';

/**
 * Resolved at the composition root: the local session identity, the rollback
 * mode, and the effective bootstrap degree (already clamped to the peer
 * connection budget).
 */
export type BootstrapOverlayPolicy = Readonly<{
    localSessionId: string;
    mode: RtcGroupFormationMode;
    bootstrapDegree: number;
}>;

/**
 * Bootstrap-overlay writer for group snapshot updates. In 'bounded-bootstrap'
 * mode the overlay is a rendezvous-selected bounded set and is written only
 * while no server overlay record exists for the group — a server overlay,
 * active or removed, is authoritative and the bootstrap star must not be
 * restamped over it. 'legacy-star' mode preserves the pre-Phase-1 behavior:
 * an unconditional full-membership star (admission still keeps server
 * overlays authoritative once adopted).
 */
export function createAndSetBootstrapOverlays(
    groups: readonly AnyGroupPresence[],
    policy: BootstrapOverlayPolicy,
    manager?: RepositoryManager
): void {
    if (policy.mode === 'legacy-star') {
        createAndSetStarOverlays(groups, manager);
        return;
    }

    for (const group of groups) {
        if (hasServerOverlayRecordForGroup(group.group, manager)) {
            continue;
        }

        const overlay = toBoundedBootstrapOverlay(group, policy);
        setOverlayById(overlay.overlayId, overlay, manager);
    }
}

export function toBoundedBootstrapOverlay(
    group: AnyGroupPresence,
    policy: BootstrapOverlayPolicy
): OverlayInfo {
    const memberSessionIds = readGroupMemberSessionIds(group);
    const nextHopSessionIds = selectBootstrapPeers({
        localSessionId: policy.localSessionId,
        memberSessionIds,
        groupKey: toWebRtcGroupKey(group.group),
        bootstrapDegree: policy.bootstrapDegree
    });

    return {
        sourceGroupStateCausalRevision: readGroupCausalRevision(group),
        provenance: 'bootstrap',
        state: 'active',
        name: readGroupDisplayName(group),
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'star',
        createdByClientId: readGroupCreatedByPrincipalId(group),
        createdAtEpochMs: readGroupCreatedAtEpochMs(group),
        nextHopSessionIds,
        degreeLimit: Math.max(
            1,
            Math.min(policy.bootstrapDegree, memberSessionIds.length - 1)
        ),
        overlayVersion: readGroupVersion(group),
        updatedAtEpochMs: readGroupUpdatedAtEpochMs(group)
    };
}

function hasServerOverlayRecordForGroup(
    groupRef: GroupRef,
    manager?: RepositoryManager
): boolean {
    const scoped = readOverlayRecordById(toScopedOverlayId(groupRef), manager);
    if (scoped?.provenance === 'server') {
        return true;
    }

    const legacy = readOverlayRecordById(groupRef.groupId, manager);
    return legacy?.provenance === 'server' &&
        isOverlayForGroupRef(legacy, groupRef);
}

// Raw record read: a server overlay with state 'removed' still expresses
// server authority over the group's overlay, so the bootstrap check must see
// it even though value readers filter removed records out.
function readOverlayRecordById(
    overlayId: string,
    manager?: RepositoryManager
): OverlayInfo | undefined {
    return readObservableLatestRepositoryValue(
        overlayRepositoryToken,
        overlayId,
        manager
    );
}
