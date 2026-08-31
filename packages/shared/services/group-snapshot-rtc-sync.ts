import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createAndSetBootstrapOverlays, type BootstrapOverlayPolicy } from '@shared/repository/overlay-bootstrap.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { resolveBootstrapDegree } from '@shared/rtc/bootstrap-peer-selection.ts';
import type { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';

export interface BootstrapOverlayPolicyInput {
    readonly bootstrapDegree: number;
}

export interface GroupSnapshotRtcSyncPort
    extends Pick<WebRtcGroupManager, 'delete' | 'has' | 'ensureAllGroupsConnected'> {
    // Snapshot adoption waits for reconciliation, but does not read the manager's service result.
    acceptGroupUpdate(
        snapshot: GroupSnapshot
    ): Promise<void | Awaited<ReturnType<WebRtcGroupManager['acceptGroupUpdate']>>>;
}

export function resolveBootstrapOverlayPolicy(
    input: BootstrapOverlayPolicyInput | undefined,
    localSessionId: string
): BootstrapOverlayPolicy {
    return {
        localSessionId,
        bootstrapDegree: input?.bootstrapDegree ??
            resolveBootstrapDegree({})
    };
}

export function isSameBootstrapOverlayPolicy(
    left: BootstrapOverlayPolicy,
    right: BootstrapOverlayPolicy
): boolean {
    return left.localSessionId === right.localSessionId &&
        left.bootstrapDegree === right.bootstrapDegree;
}

export async function acceptGroupSnapshotUpdate(
    snapshot: GroupSnapshot,
    webRtcGroupManager: GroupSnapshotRtcSyncPort,
    bootstrapOverlayPolicy: BootstrapOverlayPolicy
): Promise<void> {
    if (!isGroupActive(snapshot)) {
        clearGroupOverlayRoles(snapshot);
        await waitForGroupOverlayRolesIdle();

        await webRtcGroupManager.delete(snapshot.group);
        return;
    }

    if (!isSessionInGroup(snapshot, bootstrapOverlayPolicy.localSessionId)) {
        clearGroupOverlayRoles(snapshot);
        await waitForGroupOverlayRolesIdle();
        if (webRtcGroupManager.has(snapshot.group)) {
            await webRtcGroupManager.delete(snapshot.group, { retainConnections: true });
        }
        else {
            await webRtcGroupManager.ensureAllGroupsConnected();
        }
        return;
    }

    overlaysRepository.reconcileAcceptedOverlayIdentity({
        overlayId: toScopedOverlayId(snapshot.group),
        acceptedIdentity: snapshot.group.acceptedLayoutIdentity ?? undefined
    });
    createAndSetBootstrapOverlays([snapshot], bootstrapOverlayPolicy);
    await waitForGroupOverlayRolesIdle();
    await webRtcGroupManager.acceptGroupUpdate(snapshot);
}

export async function acceptGroupSnapshotRemoval(
    snapshot: GroupSnapshot,
    webRtcGroupManager: Pick<WebRtcGroupManager, 'delete'>
): Promise<void> {
    clearGroupOverlayRoles(snapshot);
    await waitForGroupOverlayRolesIdle();

    await webRtcGroupManager.delete(snapshot.group);
}

function clearGroupOverlayRoles(snapshot: GroupSnapshot): void {
    overlaysRepository.removePlannedOverlayByGroupRef(snapshot.group);
    overlaysRepository.removeAcceptedOverlayByGroupRef(snapshot.group);
}

async function waitForGroupOverlayRolesIdle(): Promise<void> {
    await Promise.all([
        overlaysRepository.waitForPlannedOverlayChangesIdle(),
        overlaysRepository.waitForAcceptedOverlayChangesIdle()
    ]);
}
