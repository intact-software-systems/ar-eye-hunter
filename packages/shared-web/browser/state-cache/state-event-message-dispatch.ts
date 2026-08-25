import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

import { reconcileGroupStateDelta } from '../state-read/reconcile-group-state-delta.ts';
import { parseGroupStateDeltaEnvelope } from './group-state-delta-application.ts';

export interface DispatchStateEventMessageInput {
    readonly message: ALMessage;
    readonly scope: StateScope;
    readonly rereadGroupSnapshots:
        | ((
            scope: StateScope
        ) => Promise<readonly GroupSnapshot[]>)
        | undefined;
    readonly waitForLifecycleObservers: () => Promise<void>;
}

export async function dispatchStateEventMessage(
    input: DispatchStateEventMessageInput
): Promise<boolean> {
    if (input.message.payload.typeId === AppTopics.clientStateEvent) {
        return true;
    }
    if (input.message.payload.typeId !== AppTopics.groupStateEvent) {
        return false;
    }
    const envelope = parseGroupStateDeltaEnvelope(
        input.message.payload.resource,
        input.scope
    );
    if (envelope === undefined) {
        return true;
    }
    await reconcileGroupStateDelta({
        envelope,
        scope: input.scope,
        rereadGroupSnapshots: input.rereadGroupSnapshots
    });
    await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();
    await input.waitForLifecycleObservers();
    return true;
}
