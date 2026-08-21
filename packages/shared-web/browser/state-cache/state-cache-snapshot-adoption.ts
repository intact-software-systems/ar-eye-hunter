import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export function acceptClientStateSnapshots(
    snapshots: readonly ClientStateSnapshot[],
    scope: StateScope
): boolean {
    return clientStateSnapshotsRepository.setClientStateSnapshots(
        snapshots.filter((snapshot) => isClientSnapshotInScope(snapshot, scope))
    );
}

export async function acceptGroupStateSnapshotsOrRecompute(
    snapshots: readonly GroupStateSnapshot[],
    scope: StateScope,
    rereadGroupSnapshots?: (
        scope: StateScope
    ) => Promise<readonly GroupStateSnapshot[]>
): Promise<boolean> {
    try {
        return acceptGroupStateSnapshots(snapshots, scope);
    }
    catch (error) {
        if (
            error instanceof
                groupStateSnapshotsRepository.GroupStateSnapshotIncomparableError
        ) {
            if (!rereadGroupSnapshots) {
                throw error;
            }
            const reread = await rereadGroupSnapshots(scope);
            acceptGroupStateSnapshots(reread, scope);
            const accepted = snapshots.filter((snapshot) => isGroupSnapshotInScope(snapshot, scope));
            for (const incoming of accepted) {
                const recovered = groupStateSnapshotsRepository
                    .findGroupStateSnapshotByRef(incoming.group);
                if (
                    !recovered ||
                    !['equal', 'dominates'].includes(compareGroupCausalRevision(
                        recovered.causalRevision,
                        incoming.causalRevision
                    ))
                ) {
                    throw error;
                }
            }
            return true;
        }
        throw error;
    }
}

export function isSameStateScope(
    left: Readonly<{ applicationId: string; workspaceId?: string; }>,
    right: Readonly<{ applicationId: string; workspaceId?: string; }>
): boolean {
    return left.applicationId === right.applicationId &&
        (left.workspaceId ?? '') === (right.workspaceId ?? '');
}

function acceptGroupStateSnapshots(
    snapshots: readonly GroupStateSnapshot[],
    scope: StateScope
): boolean {
    return groupStateSnapshotsRepository.setGroupStateSnapshots(
        snapshots.filter((snapshot) => isGroupSnapshotInScope(snapshot, scope))
    );
}

function isClientSnapshotInScope(
    snapshot: ClientStateSnapshot,
    scope: StateScope
): boolean {
    return isSameStateScope(snapshot.principal, scope);
}

function isGroupSnapshotInScope(
    snapshot: GroupStateSnapshot,
    scope: StateScope
): boolean {
    return isSameStateScope(snapshot.group, scope);
}
