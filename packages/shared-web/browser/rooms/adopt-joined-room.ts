import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { acceptAuthoritativeGroupStateSnapshot } from '@shared-web/browser/state-cache/state-cache-snapshot-adoption.ts';
import { readStateGroupSnapshot, type StateGroupSnapshotRead } from '@shared-web/browser/state-read/point-read.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { Command } from '@shared/cache/Command.ts';
import { GroupStateSnapshotIncomparableError } from '@shared/repository/group-state-snapshots-repository.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';

import type { LeaveRoomInput } from './leave-room.ts';
import type { GroupSnapshot } from './room-group-state-translation.ts';
import type { RoomSessionFence } from './room-session-fence.ts';

interface AdoptJoinedRoomInput {
    readonly dependencies: Pick<LeaveRoomInput, 'stateStore' | 'acceptSnapshots'>;
    readonly context: ApiMiddleware;
    readonly snapshot: GroupSnapshot;
    readonly options: RallarOperationOptions;
    readonly assertCurrent: RoomSessionFence['assertCurrent'];
}

/** Admission is already committed. Resolve conflicting observations without issuing another join. */
export async function adoptJoinedRoom(input: AdoptJoinedRoomInput): Promise<GroupSnapshot> {
    const scope = toStateScope(input.snapshot.group);
    const assertCurrent = () => input.assertCurrent(input.context);
    assertCurrent();
    try {
        await input.dependencies.acceptSnapshots({
            context: input.context,
            clients: [],
            groups: [input.snapshot],
            scope,
            currentRoom: input.snapshot,
            assertCurrent
        });
        assertCurrent();
        return input.snapshot;
    }
    catch (error) {
        if (
            !(error instanceof GroupStateSnapshotIncomparableError) &&
            !(error instanceof StateSnapshotRevisionConflictError && error.entity === 'Group')
        ) {
            throw error;
        }
    }

    const snapshot = await readJoinedRoomAfterConflict(input);
    await acceptAuthoritativeGroupStateSnapshot(snapshot, scope, { assertCanMutate: assertCurrent });
    assertCurrent();
    await input.dependencies.acceptSnapshots({
        context: input.context,
        clients: [],
        groups: [snapshot],
        scope,
        currentRoom: snapshot,
        assertCurrent
    });
    assertCurrent();
    return snapshot;
}

/** One authenticated point read must cover both admission and the latest local observation. */
async function readJoinedRoomAfterConflict(input: AdoptJoinedRoomInput): Promise<GroupSnapshot> {
    const scope = toStateScope(input.snapshot.group);
    const assertCurrent = () => input.assertCurrent(input.context);
    assertCurrent();
    const cached = input.dependencies.stateStore.findGroupSnapshot(input.snapshot.group);
    const minCausalRevision = {
        groupRevision: Math.max(input.snapshot.causalRevision.groupRevision, cached?.causalRevision.groupRevision ?? 0),
        presenceRevision: Math.max(
            input.snapshot.causalRevision.presenceRevision,
            cached?.causalRevision.presenceRevision ?? 0
        )
    };
    const { snapshot } = await new Command<StateGroupSnapshotRead>(
        async (signal) => {
            assertCurrent();
            return await readStateGroupSnapshot(input.snapshot.group.groupId, scope, {
                authSession: input.context.session,
                signal,
                minCausalRevision
            });
        },
        toRallarCommandOptions({ ...input.options, timeoutMs: input.options.timeoutMs ?? 15000 })
    ).run();
    assertCurrent();
    const comparison = compareGroupCausalRevision(snapshot.causalRevision, minCausalRevision);
    if (comparison !== 'equal' && comparison !== 'dominates') {
        throw new Error('Current room read does not cover the admitted and observed revisions.');
    }
    return snapshot;
}
