import { GroupStateRepository } from '../../persistence/group-state-repository.ts';
import type {
    GroupMutationCommand,
    GroupMutationRead,
    GroupMutationSnapshotRead
} from '../group-mutation-contracts.ts';
import { readsGroupActiveMemberPrincipalIds, readsGroupLifecyclePolicy } from './group-mutation-read-scope.ts';
import { readExactGroupMutation } from './read-exact-group-mutation.ts';
import { readSequentialGroupMutation } from './read-sequential-group-mutation.ts';

export async function readGroupMutation(
    repository: GroupStateRepository,
    command: GroupMutationCommand
): Promise<GroupMutationRead> {
    const exact = readsExactGroupMutation(command)
        ? await readExactGroupMutation({ repository, command, includeGroupSnapshot: false })
        : null;
    return exact?.read ?? await readSequentialGroupMutationWithPolicy(repository, command);
}

/**
 * The read and the group snapshot the command's result carries. The exact read takes both from one statement, so
 * the snapshot always matches the read; the sequential read runs beside a snapshot read of its own.
 */
export async function readGroupMutationWithSnapshot(
    repository: GroupStateRepository,
    command: GroupMutationCommand
): Promise<GroupMutationSnapshotRead> {
    const exact = readsExactGroupMutation(command)
        ? await readExactGroupMutation({ repository, command, includeGroupSnapshot: true })
        : null;
    if (exact !== null) {
        if (exact.groupSnapshot.status !== 'read') {
            throw new TypeError('An exact read that includes the group snapshot returns it');
        }
        return { read: exact.read, currentSnapshot: exact.groupSnapshot.snapshot };
    }
    const [read, currentSnapshot] = await Promise.all([
        readSequentialGroupMutationWithPolicy(repository, command),
        repository.readSnapshot(command.aggregateRef)
    ]);
    return { read, currentSnapshot };
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
