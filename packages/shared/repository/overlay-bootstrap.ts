import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId, toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
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
import { readObservableLatestRepositoryValue } from '@shared/cache/LatestRepositoryHelpers.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { selectBootstrapPeers } from '@shared/rtc/bootstrap-peer-selection.ts';
import { overlayRepositoryToken, setOverlayById } from './overlays-repository.ts';

/**
 * Resolved at the composition root: the local session identity and effective
 * bootstrap degree (already clamped to the peer connection budget).
 */
export type BootstrapOverlayPolicy = Readonly<{
    localSessionId: string;
    bootstrapDegree: number;
}>;

/**
 * Bootstrap-overlay writer for group snapshot updates. The overlay is a
 * rendezvous-selected bounded set and is written only while no server overlay
 * record exists for the group. A server overlay, active or removed, is
 * authoritative and the bootstrap star must not be restamped over it.
 */
export function createAndSetBootstrapOverlays(
    groups: readonly AnyGroupPresence[],
    policy: BootstrapOverlayPolicy,
    manager?: RepositoryManager
): void {
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
    groupRef: AnyGroupPresence['group'],
    manager?: RepositoryManager
): boolean {
    const scoped = readOverlayRecordById(toScopedOverlayId(groupRef), manager);
    return scoped?.provenance === 'server';
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
