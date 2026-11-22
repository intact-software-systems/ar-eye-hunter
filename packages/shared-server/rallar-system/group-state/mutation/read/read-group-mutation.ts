import { requiresGroupLobbyRead } from '../../lobby/requires-group-lobby-read.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { readGroupLobbyState } from '../../lobby/group-lobby-storage.ts';
import { resolveGroupMutationTargetPrincipalId } from '../orchestration/resolve-group-mutation-target-identity.ts';
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

interface ReadGroupMutationInput {
    readonly repository: GroupStateRepository;
    readonly command: GroupMutationCommand;
    readonly authSessionId: string | null;
    readonly lobbyDefault?: boolean;
}

export async function readGroupMutation(
    { repository, command, authSessionId, lobbyDefault = false }: ReadGroupMutationInput
): Promise<SessionGroupMutationRead> {
    const exact = readsExactGroupMutation(command)
        ? await readExactGroupMutation({ repository, command, includeGroupSnapshot: false, authSessionId })
        : null;
    const result = exact === null
        ? { read: await readSequentialGroupMutationWithPolicy(repository, command), authSession: UNREAD_AUTH_SESSION }
        : { read: exact.read, authSession: exact.authSession };
    return { ...result, read: await readLobbyForMutation({ repository, command, read: result.read, lobbyDefault }) };
}

/**
 * The read and the group snapshot the command's result carries. The exact read takes both from one statement, so
 * the snapshot always matches the read; the sequential read runs beside a snapshot read of its own.
 */
export async function readGroupMutationWithSnapshot(
    { repository, command, authSessionId, lobbyDefault = false }: ReadGroupMutationInput
): Promise<SessionGroupMutationSnapshotRead> {
    const exact = readsExactGroupMutation(command)
        ? await readExactGroupMutation({ repository, command, includeGroupSnapshot: true, authSessionId })
        : null;
    if (exact !== null) {
        if (exact.groupSnapshot.status !== 'read') {
            throw new TypeError('An exact read that includes the group snapshot returns it');
        }
        return { read: await readLobbyForMutation({ repository, command, read: exact.read, lobbyDefault }), currentSnapshot: exact.groupSnapshot.snapshot, authSession: exact.authSession };
    }
    const [read, currentSnapshot] = await Promise.all([
        readSequentialGroupMutationWithPolicy(repository, command),
        repository.readSnapshot(command.aggregateRef)
    ]);
    return { read: await readLobbyForMutation({ repository, command, read, lobbyDefault }), currentSnapshot, authSession: UNREAD_AUTH_SESSION };
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

interface ReadLobbyForMutationInput {
    readonly repository: GroupStateRepository;
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly lobbyDefault: boolean;
}

async function readLobbyForMutation({ repository, command, read, lobbyDefault }: ReadLobbyForMutationInput): Promise<GroupMutationRead> {
    if (!requiresGroupLobbyRead(command, read, lobbyDefault)) return read;
    const configures = command.operation === 'updateGroup' && command.input.roomLobby?.operation === 'configure';
    const principalId = resolveGroupMutationTargetPrincipalId(command);
    const targets = configures ? read.activeMembers?.map(member => member.principalId) ?? [] : [];
    const lobbyState = await readGroupLobbyState({
        repository,
        roomRef: command.aggregateRef,
        principalIds: principalId ? [...targets, principalId] : targets,
        mode: command.operation === 'createGroup' ? 'expired' : 'active'
    });
    // Some lobby reads follow the group query. Recheck its revision before using the private roster and policy together.
    if (read.group) {
        const current = await repository.findGroupEntry(command.aggregateRef);
        if (current?.entry.revision !== read.group.entry.revision || current.entry.value !== read.group.entry.value) throw new RuntimeStateWriteConflictError();
    }
    return { ...read, lobbyState };
}
