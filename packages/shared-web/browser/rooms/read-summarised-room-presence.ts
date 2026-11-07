import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import { Command } from '@shared/cache/Command.ts';
import { TryWithPolicy } from '@shared/resilience/try-with-policy.ts';

import { readStateGroupSnapshot } from '../state-read/point-read.ts';
import type { GroupSnapshot } from './room-group-state-translation.ts';
import type { RoomSessionFence } from './room-session-fence.ts';

export interface SummarisedRoomPresenceInput {
    /** The presence write's reply; every later read is floored at its revision. */
    readonly snapshot: GroupSnapshot;
    readonly fence: RoomSessionFence;
    readonly context: ApiMiddleware;
    readonly options: RallarOperationOptions;
    isSummarised(snapshot: GroupSnapshot): boolean;
}

/** Presence writes commit before their summary. A successful response alone does not prove arrival. */
export async function readSummarisedRoomPresence(input: SummarisedRoomPresenceInput): Promise<GroupSnapshot> {
    if (input.isSummarised(input.snapshot)) {
        return input.snapshot;
    }
    const timeoutMs = input.options.timeoutMs ?? 15000;
    return await new Command(async (signal) => {
        return await TryWithPolicy.defaults().label('room presence')
            .maxElapsedMsecs(timeoutMs)
            .retryIntervalMsecs(100).maxRetryIntervalMsecs(500)
            .retryIf((error) => error instanceof RoomPresencePendingError && !signal?.aborted)
            .run(() => readSummarisedSnapshot(input, signal));
    }, { signal: input.options.signal, timeoutMs }).run();
}

async function readSummarisedSnapshot(
    input: SummarisedRoomPresenceInput,
    signal: AbortSignal | undefined
): Promise<GroupSnapshot> {
    signal?.throwIfAborted();
    input.fence.assertCurrent(input.context);
    const { group, causalRevision } = input.snapshot;
    const { snapshot } = await readStateGroupSnapshot(group.groupId, toStateScope(group), {
        authSession: input.fence.session,
        signal,
        minCausalRevision: causalRevision
    });
    input.fence.assertCurrent(input.context);
    if (!input.isSummarised(snapshot)) {
        throw new RoomPresencePendingError('Room presence has not confirmed the switch yet. Retry entering.');
    }
    return snapshot;
}

class RoomPresencePendingError extends Error {}
