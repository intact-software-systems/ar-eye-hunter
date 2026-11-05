import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { readStateGroupSnapshot } from '@shared-web/browser/state-read/point-read.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import { Command } from '@shared/cache/Command.ts';
import { TryWithPolicy } from '@shared/resilience/try-with-policy.ts';

import type { GroupSnapshot } from './room-group-state-translation.ts';
import type { RoomSessionFence } from './room-session-fence.ts';

export interface RoomSessionPresenceInput {
    readonly snapshot: GroupSnapshot;
    readonly sessionId: string;
    readonly generationId: string;
    readonly present: boolean;
    readonly fence: RoomSessionFence;
    readonly context: ApiMiddleware;
    readonly options: RallarOperationOptions;
    readonly minPresenceRevision: number;
}

/** Presence writes commit before their summary. A successful response alone does not prove arrival. */
export async function readRoomSessionPresence(input: RoomSessionPresenceInput): Promise<GroupSnapshot> {
    const matches = (snapshot: GroupSnapshot) => {
        if (snapshot.causalRevision.presenceRevision < input.minPresenceRevision) {
            return false;
        }
        const session = snapshot.activeSessions.find((candidate) => candidate.sessionId === input.sessionId);
        return input.present
            ? session?.generationId === input.generationId && session.expiresAtEpochMs > Date.now()
            : session === undefined;
    };
    if (matches(input.snapshot)) {
        return input.snapshot;
    }
    return await new Command(async (signal) => {
        return await TryWithPolicy.defaults().label('room presence')
            .maxElapsedMsecs(input.options.timeoutMs ?? 15000)
            .retryIntervalMsecs(100).maxRetryIntervalMsecs(500)
            .retryIf((error) => error instanceof RoomPresencePendingError && !signal?.aborted)
            .run(async () => {
                signal?.throwIfAborted();
                input.fence.assertCurrent(input.context);
                const { snapshot } = await readStateGroupSnapshot(
                    input.snapshot.group.groupId,
                    toStateScope(input.snapshot.group),
                    {
                        authSession: input.fence.session,
                        signal,
                        minCausalRevision: input.snapshot.causalRevision
                    }
                );
                input.fence.assertCurrent(input.context);
                if (!matches(snapshot)) {
                    throw new RoomPresencePendingError(
                        'Room presence has not confirmed the switch yet. Retry entering.'
                    );
                }
                return snapshot;
            });
    }, { signal: input.options.signal, timeoutMs: input.options.timeoutMs ?? 15000 }).run();
}

class RoomPresencePendingError extends Error {}
