import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import {
    parseAuthoritativeClientSnapshot,
    parseAuthoritativeGroupSnapshot
} from '@shared/api/authoritative-state-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

import {
    acceptClientStateSnapshots,
    acceptGroupStateSnapshotsOrRecompute
} from './state-cache-snapshot-adoption.ts';

export interface DispatchStateSnapshotMessageInput {
    readonly message: ALMessage;
    readonly scope: StateScope;
    readonly rereadGroupSnapshots: ((
        scope: StateScope
    ) => Promise<readonly GroupSnapshot[]>) | undefined;
    readonly waitForLifecycleObservers: () => Promise<void>;
}

export async function dispatchStateSnapshotMessage(
    input: DispatchStateSnapshotMessageInput
): Promise<boolean> {
    switch (input.message.payload.typeId) {
        case AppTopics.clientStateSnapshot:
            acceptClientStateSnapshots([
                parseAuthoritativeClientSnapshot(
                    input.message.payload.resource,
                    input.scope
                )
            ], input.scope);
            await clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle();
            await input.waitForLifecycleObservers();
            return true;
        case AppTopics.groupStateSnapshot:
        case AppTopics.groupDirectorySnapshot:
            await acceptGroupStateSnapshotsOrRecompute(
                [parseAuthoritativeGroupSnapshot(
                    input.message.payload.resource,
                    input.scope
                )],
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
