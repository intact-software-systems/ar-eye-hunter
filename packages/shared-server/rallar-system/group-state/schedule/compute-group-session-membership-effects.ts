import { isGroupSpectator } from '@shared/api/group-spectating.ts';
import type { GroupMember } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type {
    GroupMutationCommand,
    GroupMutationDomainWrite,
    GroupMutationRead
} from '../mutation/group-mutation-contracts.ts';
import { groupSessionIntentPrincipal } from '../mutation/read/group-mutation-read-scope.ts';
import { GROUP_SESSION_INTENTS_NAMESPACE, groupSessionIntentKey } from './group-session-intent-storage.ts';

/** Membership and private session capacity/discovery commit together behind the same group CAS. */
export function computeGroupSessionMembershipEffects(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    members: readonly GroupMember[]
): Pick<GroupMutationDomainWrite, 'sessionIntentEffect' | 'sessionReservationWrite'> {
    const reservations = read.sessionReservations;
    if (reservations === null) {
        return { sessionIntentEffect: null, sessionReservationWrite: null };
    }
    // Joining claims a seat; leaving or revoked access releases an unclaimed seat. Watching alone does neither.
    const released = new Set(
        members.filter((member) =>
            member.status === 'active' && !isGroupSpectator(member) ||
            member.status === 'left' || member.status === 'removed' || member.status === 'banned'
        ).map((member) => member.principalId)
    );
    const principalIds = reservations.value.principalIds.filter((principalId) => !released.has(principalId));
    const principalId = groupSessionIntentPrincipal(command);
    const needsInterest = principalId !== null && read.sessionIntent === null &&
        members.some((member) => member.principalId === principalId && member.status === 'active');
    return {
        sessionReservationWrite: principalIds.length === reservations.value.principalIds.length
            ? null
            : { value: { ...reservations.value, principalIds }, expectedRevision: reservations.entry.revision },
        sessionIntentEffect: needsInterest
            ? {
                effectId: 'session-interest',
                operation: 'insert',
                namespace: GROUP_SESSION_INTENTS_NAMESPACE,
                key: groupSessionIntentKey(command.aggregateRef, principalId),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                value: JSON.stringify({
                    ...command.aggregateRef,
                    principalId,
                    reviewedScheduleRevision: reservations.value.scheduleRevision
                })
            }
            : null
    };
}
