import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { closesGuestPlayOccurrence, roomGuestAccessMode } from '@shared/api/room-guests/access.ts';
import type { PersistedAuthSession } from '../../../auth/persistence/persisted-auth-session.ts';
import { GroupMutationAuthorizationError } from '../../group-mutation-authority.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';

interface GuestPermissionInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly session: PersistedAuthSession | undefined;
    readonly now: number;
}

export function assertGroupGuestPermission({ command, read, session, now }: GuestPermissionInput): void {
    if (!session?.guestRoom) {
        return;
    }

    if (!isSameGroupRef(command.aggregateRef, session.guestRoom)) {
        throw new GroupMutationAuthorizationError('Guest credentials are limited to the admitted room.');
    }
    const member = read.actorMember?.principalId === session.clientId ? read.actorMember : read.targetMember;
    const mode = member?.principalId === session.clientId && read.group
        ? roomGuestAccessMode(read.group.value, member, now)
        : 'expired';
    if (mode === 'expired') {
        throw new GroupMutationAuthorizationError('Guest room admission ended.');
    }
    const temporaryManager = mode === 'room' && read.group?.value.temporaryPlayerRoom === true &&
        read.group.value.ownerPrincipalId === member?.principalId && member?.guestLease?.temporaryManager === true;
    switch (command.operation) {
        case 'transferGroupOwnership':
            // A completed transfer may be replayed by its original actor after giving up management.
            if (temporaryManager || (mode === 'room' && read.group?.value.temporaryPlayerRoom && read.idempotency)) return;
            break;
        case 'removeGroupMember':
            if (temporaryManager) return;
            break;
        case 'connectPresence':
        case 'heartbeatPresence':
        case 'disconnectPresence':
        case 'subscribeGroupTopic':
        case 'unsubscribeGroupTopic':
            if (command.sessionId === session.sessionId) {
                return;
            }
            break;
        case 'upsertMember':
            // Leaving frees the guest's own seat; readmission needs a fresh identity and invitation.
            if (command.targetPrincipalId === session.clientId && command.input.status === 'left') {
                return;
            }
            break;
        case 'appointDirector':
            if (mode === 'room' && member?.guestLease?.courtSessionId === session.sessionId && !command.input.succession) return;
            if (temporaryManager && (command.input.succession?.operation === 'configure' || command.input.succession?.operation === 'appoint')) return;
            if (
                mode === 'room' && (command.input.succession?.operation === 'claim-player' ||
                    command.input.succession?.operation === 'claim-deputy')
            ) {
                return;
            }
            break;
        case 'updateGroup':
            if (temporaryManager && command.input.guestInvitationVerifier !== undefined) return;
            if (
                mode === 'finish-round' && closesGuestPlayOccurrence(command.input.roomClock) &&
                command.input.roomDeadline === undefined
            ) {
                return;
            }
            // The director fence independently checks the current appointment, epoch and absence of unrelated edits.
            if (
                mode === 'room' &&
                (command.input.roomClock?.expectedDirectorEpoch !== undefined ||
                    command.input.roomDeadline?.expectedDirectorEpoch !== undefined)
            ) {
                return;
            }
            break;
    }
    throw new GroupMutationAuthorizationError('Guest room operation is unavailable.');
}
