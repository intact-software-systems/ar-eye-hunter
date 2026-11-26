import { transferEventRoom } from './transfer-event-room.ts';
import { GROUP_RETENTION_METADATA_KEY } from '@shared/api/group-retention.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import { toRoomGuestInvitation } from '@shared/api/room-guests/invitation.ts';
import type { EventRoomAccessEffects } from './event-room-access-effects.ts';
import { computeCreate } from '../group-state/mutation/aggregate/create-initial-group-mutation.ts';
import { groupWrite } from '../group-state/mutation/aggregate/compute-group-aggregate-mutation.ts';
import type { GroupMutationCommand, GroupMutationComputed, GroupMutationFacts, GroupMutationRead } from '../group-state/mutation/group-mutation-contracts.ts';
import { auditStamp } from '../group-state/mutation/group-mutation-result.ts';
import { assertGuestTransport } from '../group-state/mutation/membership/group-guest-admission.ts';
import { computeDepartureGrantEffects, computeMembershipSubscriptionEffects } from '../group-state/mutation/membership/compute-group-membership-mutation.ts';
import { createUpsertGroupMember } from '../group-state/mutation/membership/transition-group-member-lifecycle.ts';
import { computeMemberPresenceAdmission } from '../group-state/mutation/presence/compute-group-presence-admission.ts';
import { computeGroupMembershipWrite } from '../group-state/mutation/write/compute-group-membership-write.ts';

export type RoomChange =
    | { readonly kind: 'handover'; readonly priorOrganizer: string }
    | { readonly kind: 'open'; readonly capacity: number }
    | { readonly kind: 'attach' | 'close' }
    | { readonly kind: 'rotate'; readonly verifier: string }
    | { readonly kind: 'admit' | 'release' | 'remove'; readonly principal: string };

export interface RoomChangeRead {
    readonly ref: GroupRef;
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
}

export function computeEventRoomChange(input: EventRoomAccessEffects.Input, change: RoomChange, data: RoomChangeRead): GroupMutationComputed | null {
    const { command, read, facts } = data;
    const binding = { lobbyGroupId: input.lobbyRef.groupId, organizerPlaying: false, emptyReturnWindowMs: input.after.emptyReturnWindowMs };
    if (change.kind === 'open' && command.operation === 'createGroup') return computeCreate({ command, read, facts, eventBinding: binding });
    const stored = read.group?.value;
    if (!stored) {
        if (input.after.closed) return null;
        throw new TypeError('Event room is unavailable.');
    }
    if (change.kind === 'attach') {
        if (stored.eventRoom || stored.kind !== 'room' || stored.status !== 'active' || stored.temporaryPlayerRoom ||
            stored.ownerPrincipalId !== input.after.organizerId || (stored.expiresAtEpochMs !== null && stored.expiresAtEpochMs < input.after.closesAt)) {
            throw new TypeError('Event creation requires an available organizer-owned lobby.');
        }
        const { [GROUP_RETENTION_METADATA_KEY]: _independentRoomRetention, ...metadata } = stored.metadata;
        return publishGroup(data, { ...stored, metadata, emptySinceEpochMs: null,
            joinMode: 'invite-only', expiresAtEpochMs: input.after.closesAt, eventRoom: binding });
    }
    if (!stored.eventRoom || stored.eventRoom.lobbyGroupId !== binding.lobbyGroupId) throw new TypeError('Room belongs to another event.');
    if (change.kind === 'handover') return transferEventRoom(input, data);
    if (change.kind === 'close') {
        const { guestInvitation: _retired, ...group } = stored;
        return publishGroup(data, { ...group, status: 'archived', archived: auditStamp(command, facts, undefined), deleted: null });
    }
    if (change.kind === 'rotate') return publishGroup(data, { ...stored, guestInvitation: toRoomGuestInvitation(change.verifier, facts.attemptAtEpochMs) });
    if (!('principal' in change)) throw new TypeError('Invalid event room change.');
    return computeEventParticipantChange(input, change, data);
}

function computeEventParticipantChange(input: EventRoomAccessEffects.Input, change: Extract<RoomChange, { principal: string }>,
    data: RoomChangeRead): GroupMutationComputed | null {
    const { command, read, facts } = data;
    const stored = read.group?.value;
    const binding = stored?.eventRoom;
    if (command.operation !== 'upsertMember' || !binding) throw new TypeError('Invalid event participant change.');
    if (change.principal === stored.ownerPrincipalId && stored.groupId !== binding.lobbyGroupId) {
        const group = { ...stored, eventRoom: { ...binding, organizerPlaying: change.kind === 'admit' } };
        if (change.kind === 'admit') return publishGroup(data, group);
        if (!read.targetMember) throw new TypeError('Event court organizer is missing.');
        // The organizer retains ownership, but releasing its playing seat revokes the current court sessions.
        const departed = createUpsertGroupMember({ command, facts, existing: read.targetMember, role: 'owner',
            status: 'left', invitedByPrincipalId: null, invitationExpiresAtEpochMs: null });
        return publishGroup(data, group, {
            presenceAdmission: computeMemberPresenceAdmission({ read, facts, members: [departed] }),
            publicationGrantEffects: computeDepartureGrantEffects(read, departed),
            subscriptionEffects: computeMembershipSubscriptionEffects(data.ref, read, departed)
        });
    }
    if (change.kind === 'release' && read.targetMember?.status !== 'active') return null;
    if (change.kind === 'remove' && read.targetMember?.status === 'banned') return null;
    const status = change.kind === 'admit' ? 'active' : change.kind === 'release' ? 'left' : 'banned';
    const base = createUpsertGroupMember({ command, facts, existing: read.targetMember ?? undefined, role: 'member',
        status, invitedByPrincipalId: null, invitationExpiresAtEpochMs: null });
    const transport = change.kind === 'admit' ? input.guestTransport : undefined;
    if (change.kind === 'admit') {
        if (input.command.action !== 'claim' || change.principal !== input.actor?.principalId ||
            Boolean(transport) !== Boolean(input.actorGuestLease) || (input.actorGuestLease && input.actorGuestLease.expiresAtEpochMs <= facts.attemptAtEpochMs)) {
            throw new TypeError('Court claim requires the accepting player’s current event admission.');
        }
        if (transport) assertGuestTransport(transport);
    }
    const lease = transport && input.actorGuestLease && {
        admittedAtEpochMs: input.actorGuestLease.admittedAtEpochMs, expiresAtEpochMs: input.actorGuestLease.expiresAtEpochMs,
        ...(input.actorGuestLease.displayName && { displayName: input.actorGuestLease.displayName }), courtSessionId: transport.sessionId
    };
    const member = lease ? { ...base, guestLease: lease } : base;
    return computeGroupMembershipWrite({ command, read, facts, members: [member], eventMembership: {
        transport: lease && transport ? { ...transport, guestRoom: data.ref, clientId: change.principal, username: change.principal,
            issuedAtEpochMs: lease.admittedAtEpochMs, expiresAtEpochMs: lease.expiresAtEpochMs } : undefined
    }, eventType: status === 'active' ? 'member-joined' : status === 'left' ? 'member-left' : 'member-banned',
    publicationGrantEffects: computeDepartureGrantEffects(read, member), subscriptionEffects: computeMembershipSubscriptionEffects(data.ref, read, member) });
}

function publishGroup({ command, read, facts }: RoomChangeRead, group: Group, departure?: Parameters<typeof groupWrite>[0]['departure']): GroupMutationComputed {
    return groupWrite({ command, read, facts, departure, group: { ...group, snapshotVersion: group.snapshotVersion + 1,
        metadataVersion: group.metadataVersion + 1, updated: auditStamp(command, facts, undefined) },
        eventType: group.status === 'archived' ? 'group-archived' : 'group-updated' });
}
