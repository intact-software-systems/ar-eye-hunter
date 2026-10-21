import { GroupStateRepository } from '../../persistence/group-state-repository.ts';
import type { GroupStateMutationExactAuthSession } from '../../persistence/read-exact-group-state-mutation.ts';
import type {
    GroupMutationCommand,
    GroupMutationRead,
    GroupMutationSnapshotRead
} from '../group-mutation-contracts.ts';
import { readsGroupActiveMemberPrincipalIds, readsGroupLifecyclePolicy } from './group-mutation-read-scope.ts';
import { readExactGroupMutation } from './read-exact-group-mutation.ts';
import { readSequentialGroupMutation } from './read-sequential-group-mutation.ts';

/** A mutation read and the authenticated session its statement selected; unread when the read was sequential. */
export interface SessionGroupMutationRead {
    readonly read: GroupMutationRead;
    readonly authSession: GroupStateMutationExactAuthSession;
}

/** A mutation read with its result snapshot, and the authenticated session its statement selected. */
export interface SessionGroupMutationSnapshotRead extends GroupMutationSnapshotRead {
    readonly authSession: GroupStateMutationExactAuthSession;
}

const UNREAD_AUTH_SESSION: GroupStateMutationExactAuthSession = { status: 'unread' };

export async function readGroupMutation(
    repository: GroupStateRepository,
    command: GroupMutationCommand,
    authSessionId: string | null
): Promise<SessionGroupMutationRead> {
    const exact = readsExactGroupMutation(command)
        ? await readExactGroupMutation({ repository, command, includeGroupSnapshot: false, authSessionId })
        : null;
    return exact === null
        ? { read: await readSequentialGroupMutationWithPolicy(repository, command), authSession: UNREAD_AUTH_SESSION }
        : { read: exact.read, authSession: exact.authSession };
}

/**
 * The read and the group snapshot the command's result carries. The exact read takes both from one statement, so
 * the snapshot always matches the read; the sequential read runs beside a snapshot read of its own.
 */
export async function readGroupMutationWithSnapshot(
    repository: GroupStateRepository,
    command: GroupMutationCommand,
    authSessionId: string | null
): Promise<SessionGroupMutationSnapshotRead> {
    const exact = readsExactGroupMutation(command)
        ? await readExactGroupMutation({ repository, command, includeGroupSnapshot: true, authSessionId })
        : null;
    if (exact !== null) {
        if (exact.groupSnapshot.status !== 'read') {
            throw new TypeError('An exact read that includes the group snapshot returns it');
        }
        return { read: exact.read, currentSnapshot: exact.groupSnapshot.snapshot, authSession: exact.authSession };
    }
    const [read, currentSnapshot] = await Promise.all([
        readSequentialGroupMutationWithPolicy(repository, command),
        repository.readSnapshot(command.aggregateRef)
    ]);
    return { read, currentSnapshot, authSession: UNREAD_AUTH_SESSION };
}

function readsExactGroupMutation(command: GroupMutationCommand): boolean {
    return command.operation !== 'appointDirector' && !readsGroupActiveMemberPrincipalIds(command.operation);
}

async function readSequentialGroupMutationWithPolicy(
    repository: GroupStateRepository,
    command: GroupMutationCommand
): Promise<GroupMutationRead> {
    // Safe beside the sequential read because the policy document is written
    // once at creation and never updated in this release; a policy-update
    // surface must move this into the read's stability window.
    const lifecyclePolicy = readsGroupLifecyclePolicy(command.operation)
        ? await repository.readLifecyclePolicy(command.aggregateRef)
        : null;
    return await readSequentialGroupMutation({ repository, command, lifecyclePolicy });
}
