import { isLiveGroupPresenceSession } from '../../policy/group-policy-primitives.ts';
import { roomGuestAccessMode } from '@shared/api/room-guests/access.ts';
import { ROOM_GUEST_LIFETIME_MS } from '@shared/api/room-guests/invitation.ts';
import { canJoinGroup } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { AuditStamp, GroupMember, GroupRef } from '@shared/api/group-types.ts';

import { readJoinCode } from '../../policy/group-join-code.ts';
import {
    assertAllowed,
    assertGovernance,
    assertNotLastOwner,
    assertPrincipalAuthority,
    toPolicySnapshot
} from '../aggregate/group-aggregate-mutation-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead,
    GroupPublicationGrantEffect,
    GroupTopicSubscriptionDeleteEffect
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { auditStamp, noOp, requireGroup } from '../group-mutation-result.ts';
import { toTopicSubscriptionDeleteEffects } from '../subscription/compute-group-topic-subscription-mutation.ts';
import { computeGroupMembershipWrite } from '../write/compute-group-membership-write.ts';
import { resolveAdmittedMemberStatus } from './compute-group-admission-mutation.ts';
import {
    assertGovernedParticipationChange,
    assertUpsertActivationAllowed,
    assertUpsertAuthority,
    assertUpsertRoleChange,
    governanceActionFor,
    governedMemberEventType,
    governedMemberRole,
    governedMemberStatus,
    resolveUpsertMemberStatus
} from './group-membership-mutation-policy.ts';
import {
    createUpsertGroupMember,
    groupMemberEventType,
    transitionGroupMemberLifecycle
} from './transition-group-member-lifecycle.ts';

const DEFAULT_GROUP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export function computeJoin(
    command: Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const guestAdmission = facts.internalAuthority === 'guest-redemption';
    if (!guestAdmission) {
        assertPrincipalAuthority(command, command.targetPrincipalId);
    }
    const stored = requireGroup(read, command.aggregateRef);
    const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs);
    const existing = read.targetMember ?? undefined;
    const joinCodeMetadata = readJoinCode(stored.value.metadata);
    assertAllowed(
        canJoinGroup({
            snapshot,
            actor: {
                principalId: command.targetPrincipalId,
                sessionId: command.input.actorSessionId ?? undefined
            },
            guestInvitationVerifier: guestAdmission ? command.input.inviteToken ?? undefined : undefined,
            nowEpochMs: facts.attemptAtEpochMs,
            capacity: facts.capacity,
            sessionReservations: read.sessionReservations?.value,
            participation: guestAdmission && existing ? undefined : command.input.participation ?? undefined,
            joinCode: command.input.joinCode ?? undefined,
            joinCodeVerifier: facts.joinCodeVerifier ?? undefined,
            expectedJoinCodeVerifier: stored.value.joinMode === 'code' ? (joinCodeMetadata?.verifier ?? '') : undefined,
            joinCodeExpiresAtEpochMs: joinCodeMetadata?.expiresAtEpochMs
        })
    );
    if (guestAdmission && existing) {
        if (!existing.guestLease || existing.status !== 'active' || existing.guestLease.expiresAtEpochMs <= facts.attemptAtEpochMs) {
            throw new GroupMutationRejectedError('This guest identity is unavailable. Use a fresh invitation and guest identity.');
        }
        return noOp(command, read, facts);
    }
    const role = command.input.participation === 'spectator'
        ? 'spectator'
        : command.input.participation === 'player' && existing?.role === 'spectator'
        ? 'member'
        : existing?.status === 'active'
        ? existing.role
        : 'member';
    const lobby = read.lobbyState?.lobby?.value;
    const existingSeat = lobby?.seats.find(seat => seat.principalId === command.targetPrincipalId);
    const deadline = existingSeat?.admissionWindow ?? existingSeat?.returnWindow ?? existingSeat?.offerWindow;
    const requiresSeat = role !== 'spectator' && lobby && (!existingSeat || (deadline && deadline.dueAtEpochMs <= facts.attemptAtEpochMs));
    if (existing?.status === 'active' && existing.role === role && !requiresSeat) {
        return noOp(command, read, facts);
    }
    const status = role === 'spectator' ? 'active' : resolveAdmittedMemberStatus({ read, facts, existing, guestInvitation: guestAdmission });
    if (existing?.status === 'active' && status === 'pending') {
        throw new GroupMutationRejectedError('Player promotion requires admission approval.');
    }
    if (existing?.status === 'pending' && status === 'pending') {
        return noOp(command, read, facts);
    }
    const audit = auditStamp(command, facts, command.targetPrincipalId);
    const joined = createJoinedGroupMember({ command, existing, role, status, audit });
    const member = guestAdmission ? {
        ...joined,
        guestLease: {
            ...(command.input.guestDisplayName && { displayName: command.input.guestDisplayName }),
            admittedAtEpochMs: facts.attemptAtEpochMs,
            expiresAtEpochMs: facts.attemptAtEpochMs + ROOM_GUEST_LIFETIME_MS
        }
    } : joined;
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [member],
        eventType: existing?.status === 'active' ? 'member-role-changed' : groupMemberEventType(status),
        publicationGrantEffects: [],
        subscriptionEffects: computeMembershipSubscriptionEffects(command.aggregateRef, read, member)
    });
}

export function computeInvite(
    command: Extract<GroupMutationCommand, { operation: 'createGroupInvite'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance({ command, read, facts, action: 'invite' });
    const existing = read.targetMember ?? undefined;
    if (existing?.status === 'active') {
        return noOp(command, read, facts);
    }
    if (existing?.status === 'banned') {
        throw new GroupMutationRejectedError('Cannot invite a banned group member.');
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const member: GroupMember = {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: existing?.role ?? 'member',
        status: 'invited',
        joined: null,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: command.input.actorPrincipalId,
        invitationExpiresAtEpochMs: command.input.invitationExpiresAtEpochMs ??
            facts.attemptAtEpochMs + DEFAULT_GROUP_INVITE_TTL_MS
    };
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [member],
        eventType: 'member-invited',
        publicationGrantEffects: [],
        subscriptionEffects: []
    });
}

export function computeRevokeInvite(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance({ command, read, facts, action: 'remove' });
    const existing = read.targetMember ?? undefined;
    if (existing?.status !== 'invited') {
        return noOp(command, read, facts);
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [
            transitionGroupMemberLifecycle(
                {
                    ...existing,
                    updated: audit
                },
                'left',
                audit
            )
        ],
        eventType: 'member-left',
        publicationGrantEffects: [],
        subscriptionEffects: []
    });
}

export function computeGovernedMember(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    if (facts.internalAuthority === 'guest-expiry') {
        const member = read.targetMember;
        if (member?.status !== 'active' || !member.guestLease ||
            roomGuestAccessMode(requireGroup(read, command.aggregateRef).value, member, facts.attemptAtEpochMs) !== 'expired') {
            return noOp(command, read, facts);
        }
        const audit = auditStamp(command, facts, undefined);
        const departed = transitionGroupMemberLifecycle({ ...member, updated: audit }, 'left', audit);
        return computeGroupMembershipWrite({
            command, read, facts, members: [departed], eventType: 'member-left',
            publicationGrantEffects: computeDepartureGrantEffects(read, departed),
            subscriptionEffects: computeMembershipSubscriptionEffects(command.aggregateRef, read, departed)
        });
    }
    const action = governanceActionFor(command);
    assertGovernance({ command, read, facts, action });
    const existing = read.targetMember ?? undefined;
    if (!existing && command.operation === 'unbanGroupMember') {
        return noOp(command, read, facts);
    }
    if (!existing && command.operation === 'setGroupMemberRole') {
        throw new GroupMutationRejectedError(`Group member not found: ${command.targetPrincipalId}`);
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const base: GroupMember = existing ?? {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: 'member',
        status: 'left',
        joined: null,
        updated: audit,
        left: audit,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
    const status = governedMemberStatus(command, base);
    const role = governedMemberRole(command, read, base);
    assertGovernedParticipationChange({ command, read, facts, role });
    if (base.status === status && base.role === role) {
        return noOp(command, read, facts);
    }
    assertNotLastOwner({
        group: requireGroup(read, command.aggregateRef).value,
        existing: base,
        nextStatus: status,
        nextRole: role
    });
    const member = transitionGroupMemberLifecycle(
        {
            ...base,
            role,
            updated: audit
        },
        status,
        audit
    );
    const eventType = governedMemberEventType(command);
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [member],
        eventType,
        publicationGrantEffects: computeDepartureGrantEffects(read, member),
        subscriptionEffects: computeMembershipSubscriptionEffects(command.aggregateRef, read, member)
    });
}

export function computeTransfer(
    command: Extract<GroupMutationCommand, { operation: 'transferGroupOwnership'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const group = requireGroup(read, command.aggregateRef).value;
    assertGovernance({ command, read, facts, action: 'transfer-ownership' });
    const actor = read.actorMember ?? undefined;
    const target = read.targetMember ?? undefined;
    if (!actor || actor.status !== 'active' || actor.role !== 'owner') {
        throw new GroupMutationRejectedError('Only an active owner can transfer ownership.');
    }
    if (!target || target.status !== 'active') {
        throw new GroupMutationRejectedError('Ownership target must be active.');
    }
    if (actor.principalId === target.principalId) {
        return noOp(command, read, facts);
    }
    assertGovernedParticipationChange({ command, read, facts, role: 'owner' });
    const audit = auditStamp(command, facts, actor.principalId);
    const members: GroupMember[] = [
        { ...actor, role: 'admin', updated: audit },
        { ...target, role: 'owner', updated: audit }
    ];
    if (group.temporaryPlayerRoom) {
        if (!actor.guestLease?.temporaryManager || !target.guestLease || target.role !== 'member' ||
            roomGuestAccessMode(group, target, facts.attemptAtEpochMs) !== 'room' ||
            !read.authorityPresenceSessions.some(session => session.principalId === target.principalId &&
                isLiveGroupPresenceSession(session, facts.attemptAtEpochMs))) {
            throw new GroupMutationRejectedError('Transfer requires a present guest player.');
        }
        const { temporaryManager: _previousManager, ...previousLease } = actor.guestLease;
        members[0] = { ...actor, role: 'member', guestLease: previousLease, updated: audit };
        members[1] = { ...target, role: 'owner', guestLease: { ...target.guestLease, temporaryManager: true }, updated: audit };
    }
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members,
        eventType: 'ownership-transferred',
        publicationGrantEffects: [],
        subscriptionEffects: []
    });
}

export function computeUpsertMember(
    command: Extract<GroupMutationCommand, { operation: 'upsertMember'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const isSelf = command.input.actorPrincipalId === command.targetPrincipalId;
    assertUpsertAuthority({ command, read, facts, isSelf });
    assertUpsertRoleChange(command, read, isSelf);
    const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs);
    const existing = read.targetMember ?? undefined;
    const role = command.input.role ??
        (command.input.status === 'active' && existing?.status !== 'active' && existing?.role === 'spectator'
            ? 'member'
            : existing?.role ?? 'member');
    assertUpsertActivationAllowed({
        command,
        snapshot,
        role,
        nowEpochMs: facts.attemptAtEpochMs,
        capacity: facts.capacity,
        sessionReservations: read.sessionReservations
    });
    const status = resolveUpsertMemberStatus({ command, read, facts, role });
    const invitedByPrincipalId = command.input.invitedByPrincipalId ?? existing?.invitedByPrincipalId ?? null;
    const invitationExpiresAtEpochMs = command.input.invitationExpiresAtEpochMs ??
        existing?.invitationExpiresAtEpochMs ?? null;
    if (
        existing &&
        existing.status === status &&
        existing.role === role &&
        existing.invitedByPrincipalId === invitedByPrincipalId &&
        existing.invitationExpiresAtEpochMs === invitationExpiresAtEpochMs
    ) {
        return noOp(command, read, facts);
    }
    const member = createUpsertGroupMember({
        command,
        facts,
        existing,
        status,
        role,
        invitedByPrincipalId,
        invitationExpiresAtEpochMs
    });
    assertNotLastOwner({
        group: requireGroup(read, command.aggregateRef).value,
        existing,
        nextStatus: member.status,
        nextRole: member.role
    });
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [member],
        eventType: groupMemberEventType(member.status),
        publicationGrantEffects: computeDepartureGrantEffects(read, member),
        subscriptionEffects: computeMembershipSubscriptionEffects(command.aggregateRef, read, member)
    });
}

/** A departure deletes the target's grant row in its own batch, so a rejoin never finds it again (D485). */
export function computeDepartureGrantEffects(
    read: GroupMutationRead,
    member: GroupMember
): readonly GroupPublicationGrantEffect[] {
    const grant = read.targetPublicationGrant;
    return grant === null || member.status === 'active'
        ? []
        : [{ operation: 'delete', value: grant.value, expectedRevision: grant.entry.revision }];
}

/**
 * The target's rows survive only while it stays an active member across the write: a departure deletes them, and an
 * activation deletes any orphan a cross-server race left, so a rejoin never revives an old subscription.
 */
export function computeMembershipSubscriptionEffects(
    ref: GroupRef,
    read: GroupMutationRead,
    member: GroupMember
): readonly GroupTopicSubscriptionDeleteEffect[] {
    return read.targetMember?.status === 'active' && member.status === 'active'
        ? []
        : toTopicSubscriptionDeleteEffects(ref, read.targetPrincipalSubscriptions ?? []);
}

interface CreateJoinedGroupMemberInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite'; }>;
    readonly existing: GroupMember | undefined;
    readonly role: GroupMember['role'];
    readonly status: 'active' | 'pending';
    readonly audit: AuditStamp;
}

function createJoinedGroupMember(
    { command, existing, role, status, audit }: CreateJoinedGroupMemberInput
): GroupMember {
    return {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        ...(existing?.guestLease && { guestLease: existing.guestLease }),
        role,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: existing?.invitedByPrincipalId ?? null,
        invitationExpiresAtEpochMs: existing?.invitationExpiresAtEpochMs ?? null,
        ...(status === 'active'
            ? { status, joined: existing?.joined ?? audit }
            : { status, joined: null })
    };
}
