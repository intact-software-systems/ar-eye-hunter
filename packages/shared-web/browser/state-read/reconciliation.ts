import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as clientSnapshots from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupSnapshots from '@shared/repository/group-state-snapshots-repository.ts';

import { emitBrowserStateReadDiagnostic } from './diagnostics.ts';

export type StateSnapshotCollectionObservations = Readonly<{
    clients: readonly ClientSnapshot[];
    groups: readonly GroupSnapshot[];
}>;

export function captureStateSnapshotCollectionObservations(
    scope: StateScope
): StateSnapshotCollectionObservations {
    return {
        clients: readConfiguredSnapshots(clientSnapshots.getAllClientStateSnapshots).filter(
            (snapshot) => isScope(snapshot.principal, scope)
        ),
        groups: readConfiguredSnapshots(groupSnapshots.getAllGroupStateSnapshots).filter((snapshot) =>
            isScope(snapshot.group, scope)
        )
    };
}

function readConfiguredSnapshots<T>(read: () => T[]): T[] {
    try {
        return read();
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('Repository not found:')) {
            return [];
        }
        throw error;
    }
}

export function reconcileCompleteStateSnapshotCollections(
    observations: StateSnapshotCollectionObservations,
    currentClients: readonly ClientSnapshot[],
    currentGroups: readonly GroupSnapshot[]
): void {
    const currentClientIds = new Set(
        currentClients.map((snapshot) => snapshot.principal.principalId)
    );
    for (const observed of observations.clients) {
        if (!currentClientIds.has(observed.principal.principalId)) {
            emitReconciliation(
                'client',
                clientSnapshots.removeClientStateSnapshotIfUnchanged(observed.principal, observed)
            );
        }
    }

    const currentGroupIds = new Set(currentGroups.map((snapshot) => snapshot.group.groupId));
    for (const observed of observations.groups) {
        if (!currentGroupIds.has(observed.group.groupId)) {
            emitReconciliation(
                'group',
                groupSnapshots.removeGroupStateSnapshotIfUnchanged(observed.group, observed)
            );
        }
    }
}

function emitReconciliation(feature: 'client' | 'group', removed: boolean): void {
    emitBrowserStateReadDiagnostic({
        name: 'rallar.browser.state-read',
        feature,
        operation: 'collection',
        result: removed ? 'removed' : 'preserved',
        durationMs: 0
    });
}

function isScope(
    ref: Readonly<{ applicationId: string; workspaceId?: string; }>,
    scope: StateScope
): boolean {
    return ref.applicationId === scope.applicationId && ref.workspaceId === scope.workspaceId;
}
