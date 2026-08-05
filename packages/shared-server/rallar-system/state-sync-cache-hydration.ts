import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { ClientStateService } from './client-state/client-state-service-contracts.ts';
import type { GroupStateService } from './services/group-state-service.ts';

export type StateSyncCacheHydrationInput = Readonly<{
    scope?: StateScope;
    clients?: readonly ClientSnapshot[];
    groups?: readonly GroupSnapshot[];
    clientStateService?: Pick<ClientStateService, 'listSnapshots'>;
    groupStateService?: Pick<GroupStateService, 'listSnapshots'>;
}>;

export type StateSyncCacheHydrationResult = Readonly<{
    clientSnapshotCount: number;
    groupSnapshotCount: number;
}>;

export async function hydrateStateSyncSnapshotCaches(
    input: StateSyncCacheHydrationInput,
): Promise<StateSyncCacheHydrationResult> {
    const clients = [
        ...(input.clients ?? []),
        ...(input.scope && input.clientStateService
            ? await input.clientStateService.listSnapshots(input.scope)
            : []),
    ];
    const groups = [
        ...(input.groups ?? []),
        ...(input.scope && input.groupStateService
            ? await input.groupStateService.listSnapshots(input.scope)
            : []),
    ];

    for (const snapshot of clients) {
        clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
            snapshot.principal.principalId,
            snapshot,
        );
    }

    for (const snapshot of groups) {
        groupStateSnapshotsRepository.setGroupStateSnapshot(snapshot);
    }

    await Promise.all([
        clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle(),
        groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle(),
    ]);

    return {
        clientSnapshotCount: clients.length,
        groupSnapshotCount: groups.length,
    };
}
