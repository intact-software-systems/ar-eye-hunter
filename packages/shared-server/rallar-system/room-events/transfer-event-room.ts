import type { EventRoomAccessEffects } from './event-room-access-effects.ts';
import { computeDepartureGrantEffects, computeMembershipSubscriptionEffects } from '../group-state/mutation/membership/compute-group-membership-mutation.ts';
import { createUpsertGroupMember } from '../group-state/mutation/membership/transition-group-member-lifecycle.ts';
import { computeGroupMembershipWrite } from '../group-state/mutation/write/compute-group-membership-write.ts';
import type { RoomChangeRead } from './compute-event-room-change.ts';
import type { GroupMutationComputed } from '../group-state/mutation/group-mutation-contracts.ts';

/** Transfer the administrative seat in every court. Claimed seats and their live sessions survive. */
export function transferEventRoom(input: EventRoomAccessEffects.Input, data: RoomChangeRead): GroupMutationComputed {
    const { command, read, facts, ref } = data;
    const previous = read.targetMember;
    const successorId = input.after.organizerId;
    const binding = read.group?.value.eventRoom;
    if (!previous || previous.status !== 'active' || previous.role !== 'owner' || !binding ||
        command.operation !== 'upsertMember' || command.input.actorPrincipalId !== successorId) {
        throw new TypeError('Event management no longer matches the room owner.');
    }
    const lobby = ref.groupId === binding.lobbyGroupId;
    const court = input.after.courts.find(candidate => candidate.groupId === ref.groupId);
    const playing = court?.seats.some(seat => seat.principalId === successorId && seat.deadline === null) ?? false;
    const former = createUpsertGroupMember({ command, facts, existing: previous, role: 'member',
        status: lobby || binding.organizerPlaying ? 'active' : 'left', invitedByPrincipalId: null, invitationExpiresAtEpochMs: null });
    const successor = createUpsertGroupMember({ command: { ...command, targetPrincipalId: successorId }, facts,
        existing: read.actorMember ?? undefined, role: 'owner', status: 'active', invitedByPrincipalId: null, invitationExpiresAtEpochMs: null });
    return computeGroupMembershipWrite({ command, facts, read, members: [former, successor], eventType: 'ownership-transferred',
        eventMembership: { organizerPlaying: playing }, publicationGrantEffects: computeDepartureGrantEffects(read, former),
        subscriptionEffects: computeMembershipSubscriptionEffects(ref, read, former) });
}
