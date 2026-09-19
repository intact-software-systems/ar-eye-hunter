import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';

export interface GroupStateSnapshotAdoptionOptions {
    readonly rereadGroupSnapshots?: (
        scope: StateScope
    ) => Promise<readonly GroupSnapshot[]>;
    readonly assertCanMutate?: () => void;
}

export function acceptClientStateSnapshots(
    snapshots: readonly ClientSnapshot[],
    scope: StateScope
): boolean {
    return clientStateSnapshotsRepository.setClientStateSnapshots(
        snapshots.filter((snapshot) => isClientSnapshotInScope(snapshot, scope))
    );
}

export async function acceptGroupStateSnapshotsOrRecompute(
    snapshots: readonly GroupSnapshot[],
    scope: StateScope,
    options: GroupStateSnapshotAdoptionOptions = {}
): Promise<boolean> {
    try {
        return acceptGroupStateSnapshots(snapshots, scope, options.assertCanMutate);
    }
    catch (error) {
        if (
            error instanceof
                groupStateSnapshotsRepository.GroupStateSnapshotIncomparableError
        ) {
            if (!options.rereadGroupSnapshots) {
                throw error;
            }
            const reread = await options.rereadGroupSnapshots(scope);
            acceptGroupStateSnapshots(reread, scope, options.assertCanMutate);
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

export async function acceptAuthoritativeGroupStateSnapshot(
    snapshot: GroupSnapshot,
    scope: StateScope,
    options: GroupStateSnapshotAdoptionOptions = {}
): Promise<boolean> {
    if (!isGroupSnapshotInScope(snapshot, scope)) {
        return false;
    }
    const observed = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(snapshot.group);
    try {
        const changed = await acceptGroupStateSnapshotsOrRecompute([snapshot], scope, options);
        if (!changed && observed) {
            options.assertCanMutate?.();
            groupStateSnapshotsRepository.refreshGroupStateSnapshotIfUnchanged(observed, snapshot);
        }
        return changed;
    }
    catch (error) {
        if (!(error instanceof StateSnapshotRevisionConflictError)) {
            throw error;
        }
        const current = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(
            snapshot.group
        );
        if (
            current === undefined ||
            compareGroupCausalRevision(current.causalRevision, snapshot.causalRevision) !== 'equal'
        ) {
            throw error;
        }
        options.assertCanMutate?.();
        if (
            groupStateSnapshotsRepository.replaceGroupStateSnapshotIfUnchanged(
                current,
                snapshot
            )
        ) {
            return true;
        }
        return await acceptGroupStateSnapshotsOrRecompute(
            [snapshot],
            scope,
            options
        );
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
    snapshots: readonly GroupSnapshot[],
    scope: StateScope,
    assertCanMutate?: () => void
): boolean {
    assertCanMutate?.();
    return groupStateSnapshotsRepository.setGroupStateSnapshots(
        snapshots.filter((snapshot) => isGroupSnapshotInScope(snapshot, scope))
    );
}

function isClientSnapshotInScope(
    snapshot: ClientSnapshot,
    scope: StateScope
): boolean {
    return isSameStateScope(snapshot.principal, scope);
}

function isGroupSnapshotInScope(
    snapshot: GroupSnapshot,
    scope: StateScope
): boolean {
    return isSameStateScope(snapshot.group, scope);
}
