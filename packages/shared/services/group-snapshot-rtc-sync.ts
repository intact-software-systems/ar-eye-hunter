import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import { createAndSetBootstrapOverlays, type BootstrapOverlayPolicy } from '@shared/repository/overlay-bootstrap.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { resolveBootstrapDegree } from '@shared/rtc/bootstrap-peer-selection.ts';
import type { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

export type BootstrapOverlayPolicyInput = Readonly<{
    bootstrapDegree: number;
}>;

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
    snapshot: GroupStateSnapshot,
    webRtcGroupManager: WebRtcGroupManager,
    bootstrapOverlayPolicy: BootstrapOverlayPolicy
): Promise<void> {
    if (!isGroupActive(snapshot)) {
        overlaysRepository.removeOverlayByGroupRef(snapshot.group);

        await webRtcGroupManager.delete(snapshot.group);
        return;
    }

    if (!isSessionInGroup(snapshot, bootstrapOverlayPolicy.localSessionId)) {
        overlaysRepository.removeOverlayByGroupRef(snapshot.group);
        if (webRtcGroupManager.has(snapshot.group)) {
            await webRtcGroupManager.delete(snapshot.group, { retainConnections: true });
        }
        else {
            await webRtcGroupManager.ensureAllGroupsConnected();
        }
        return;
    }

    createAndSetBootstrapOverlays([snapshot], bootstrapOverlayPolicy);
    await webRtcGroupManager.acceptGroupUpdate(snapshot);
}

export async function acceptGroupSnapshotRemoval(
    snapshot: GroupStateSnapshot,
    webRtcGroupManager: WebRtcGroupManager
): Promise<void> {
    overlaysRepository.removeOverlayByGroupRef(snapshot.group);

    await webRtcGroupManager.delete(snapshot.group);
}
