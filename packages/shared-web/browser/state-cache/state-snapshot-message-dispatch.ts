import { AppTopics } from '@shared/api/api-config.ts';
import {
    parseAuthoritativeClientSnapshot,
    parseAuthoritativeGroupSnapshot
} from '@shared/api/authoritative-state-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { CompletedStateSnapshot } from '@shared/api/state-snapshot-page.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

import { acceptClientStateSnapshots, acceptGroupStateSnapshotsOrRecompute } from './state-cache-snapshot-adoption.ts';

export interface DispatchStateSnapshotMessageInput {
    readonly snapshot: CompletedStateSnapshot;
    readonly scope: StateScope;
    readonly rereadGroupSnapshots:
        | ((
            scope: StateScope
        ) => Promise<readonly GroupSnapshot[]>)
        | undefined;
    readonly waitForLifecycleObservers: () => Promise<void>;
}

export async function dispatchStateSnapshotMessage(
    input: DispatchStateSnapshotMessageInput
): Promise<boolean> {
    switch (input.snapshot.page.typeId) {
        case AppTopics.clientStateSnapshot:
            acceptClientSnapshot(input);

            await clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle();
            await input.waitForLifecycleObservers();
            return true;
        case AppTopics.groupStateSnapshot:
        case AppTopics.groupDirectorySnapshot:
            await acceptGroupStateSnapshotsOrRecompute(
                [readGroupSnapshot(input)],
                input.scope,
                input.rereadGroupSnapshots
            );
            await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();
            await input.waitForLifecycleObservers();
            return true;
        default:
            return false;
    }
}

function acceptClientSnapshot(input: DispatchStateSnapshotMessageInput): void {
    const client = parseAuthoritativeClientSnapshot(input.snapshot.resource, input.scope);
    const page = input.snapshot.page;
    if (
        page.scope.kind !== 'principal' || page.scope.resourceId !== client.principal.principalId ||
        page.revision !== `revision=${client.stateRevision}`
    ) {
        throw new TypeError('Completed client snapshot differs from its page identity');
    }
    acceptClientStateSnapshots([client], input.scope);
}

function readGroupSnapshot(input: DispatchStateSnapshotMessageInput): GroupSnapshot {
    const group = parseAuthoritativeGroupSnapshot(input.snapshot.resource, input.scope);
    const page = input.snapshot.page;
    const revision = group.causalRevision;
    if (
        page.scope.kind !== 'group' || page.scope.resourceId !== group.group.groupId ||
        page.revision !== `group=${revision.groupRevision};presence=${revision.presenceRevision}`
    ) {
        throw new TypeError('Completed group snapshot differs from its page identity');
    }
    return group;
}
