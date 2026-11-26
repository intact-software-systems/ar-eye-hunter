import type { Group, GroupEventType, GroupMember } from '@shared/api/group-types.ts';
import { observeRoomDirectorMembership } from '@shared/api/room-directors/room-director-succession-presence.ts';

import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationDomainWrite,
    GroupMutationRead,
    GroupPublicationGrantEffect,
    GroupTopicSubscriptionDeleteEffect
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { auditStamp, computeGroupMutationWriteResult, requireGroup } from '../group-mutation-result.ts';
import { computeMemberPresenceAdmission } from '../presence/compute-group-presence-admission.ts';

export interface ComputeGroupMembershipWriteInput {
    /** Only issued after the enclosing event has accepted the assignment or departure. */
    readonly eventMembership?: { readonly transport?: GroupMutationDomainWrite['guestTransportSession'] };
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly members: readonly GroupMember[];
    readonly eventType: GroupEventType;
    readonly publicationGrantEffects: readonly GroupPublicationGrantEffect[];
    readonly subscriptionEffects: readonly GroupTopicSubscriptionDeleteEffect[];
}

export function computeGroupMembershipWrite({
    command,
    eventMembership,
    read,
    facts,
    members,
    eventType,
    publicationGrantEffects,
    subscriptionEffects
}: ComputeGroupMembershipWriteInput): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const activeMemberCount = computeActiveMemberCount(stored.value.activeMemberCount, read, members);
    const ownerPrincipalId = resolveOwnerPrincipalId(stored.value, members, eventType);
    assertOwnerTransition(members, ownerPrincipalId);
    const metadata = members.reduce(
        (current, member) => observeRoomDirectorMembership(current, member, facts.attemptAtEpochMs),
        stored.value.metadata
    );
    let group: Group = {
        ...stored.value,
        metadata,
        metadataVersion: stored.value.metadataVersion + Number(metadata !== stored.value.metadata),
        activeMemberCount,
        ownerPrincipalId,
        snapshotVersion: stored.value.snapshotVersion + 1,
        rosterVersion: stored.value.rosterVersion + 1,
        updated: audit
    };
    for (const member of members) {
        const previous = findKnownMember(read, member.principalId);
        if (!previous?.guestLease) {
            continue;
        }
        const appointedManager = command.operation === 'transferGroupOwnership' && group.temporaryPlayerRoom &&
            member.role === 'owner' && member.guestLease?.temporaryManager && member.principalId === group.ownerPrincipalId;
        if (!appointedManager && (member.role === 'admin' || member.role === 'owner')) {
            throw new GroupMutationRejectedError('Guest members cannot govern the room.');
        }
        if ((!eventMembership && member.status === 'active' && previous.status !== 'active') || !member.guestLease) {
            throw new GroupMutationRejectedError('A guest identity may be admitted only by redeeming an invitation.');
        }
        if (eventMembership || previous.status === member.status || facts.internalAuthority === 'guest-expiry') {
            continue;
        }
        // A guest giving up its own seat leaves the room's invitation link to the owner.
        if (
            command.input.actorPrincipalId === member.principalId && previous.status === 'active' &&
            member.status === 'left'
        ) {
            continue;
        }
        if (command.input.actorPrincipalId !== stored.value.ownerPrincipalId) {
            throw new GroupMutationRejectedError('Only the room owner may change a guest membership.');
        }
        if (previous.status === 'active' || member.status === 'removed' || member.status === 'banned') {
            const { guestInvitation: _invalidInvitation, ...revoked } = group;
            group = revoked;
        }
    }
    return computeGroupMutationWriteResult({
        eventGuestTransportSession: eventMembership?.transport,
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            operation: 'update',
            value: group,
            expectedRevision: stored.entry.revision
        },
        members,
        initialPresenceSummary: null,
        presenceAdmission: computeMemberPresenceAdmission({ read, members, facts }),
        eventType,
        lifecyclePolicy: null,
        presenceSummaryWork: 'enqueue',
        publicationGrantEffects,
        subscriptionEffects,
        subscriptionOutcome: null
    });
}

function computeActiveMemberCount(
    currentCount: number,
    read: GroupMutationRead,
    members: readonly GroupMember[]
): number {
    let activeMemberCount = currentCount;
    for (const member of members) {
        const previous = findKnownMember(read, member.principalId);
        const previousActive = previous?.status === 'active';
        const nextActive = member.status === 'active';
        if (previousActive !== nextActive) {
            activeMemberCount += nextActive ? 1 : -1;
        }
    }
    if (!Number.isSafeInteger(activeMemberCount) || activeMemberCount < 0) {
        throw new TypeError('Group activeMemberCount delta is invalid');
    }
    return activeMemberCount;
}

function resolveOwnerPrincipalId(
    group: Group,
    members: readonly GroupMember[],
    eventType: GroupEventType
): string {
    const promotedOwner = members.find(
        (member) => member.status === 'active' && member.role === 'owner'
    );
    const ownerPrincipalId = eventType === 'ownership-transferred'
        ? promotedOwner?.principalId
        : group.ownerPrincipalId;
    if (!ownerPrincipalId) {
        throw new TypeError('Group owner transition has no active owner');
    }
    return ownerPrincipalId;
}

function assertOwnerTransition(members: readonly GroupMember[], ownerPrincipalId: string): void {
    for (const member of members) {
        if (
            member.principalId === ownerPrincipalId &&
            (member.status !== 'active' || member.role !== 'owner')
        ) {
            throw new GroupMutationRejectedError('Cannot remove or demote the active group owner.');
        }
        if (
            member.status === 'active' &&
            member.role === 'owner' &&
            member.principalId !== ownerPrincipalId
        ) {
            throw new GroupMutationRejectedError(
                'Ownership can only change through a single guarded transfer.'
            );
        }
    }
}

export function findKnownMember(
    read: GroupMutationRead,
    principalId: string
): GroupMember | undefined {
    if (read.actorMember?.principalId === principalId) {
        return read.actorMember;
    }
    if (read.targetMember?.principalId === principalId) {
        return read.targetMember;
    }
    return undefined;
}
