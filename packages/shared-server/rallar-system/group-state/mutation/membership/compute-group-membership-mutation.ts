import { canJoinGroup } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { AuditStamp, GroupMember } from '@shared/api/group-types.ts';

import { readJoinCode } from '../aggregate/compute-group-aggregate-mutation.ts';
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
    GroupPublicationGrantEffect
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { auditStamp, noOp, requireGroup } from '../group-mutation-result.ts';
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
    assertPrincipalAuthority(command, command.targetPrincipalId);
    const stored = requireGroup(read, command.aggregateRef);
    const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs);
    const joinCodeMetadata = readJoinCode(stored.value.metadata);
    assertAllowed(
        canJoinGroup({
            snapshot,
            actor: {
                principalId: command.input.actorPrincipalId ?? undefined,
                sessionId: command.input.actorSessionId ?? undefined
            },
            nowEpochMs: facts.attemptAtEpochMs,
            capacity: facts.capacity,
            participation: command.input.participation ?? undefined,
            joinCode: command.input.joinCode ?? undefined,
            joinCodeVerifier: facts.joinCodeVerifier ?? undefined,
            expectedJoinCodeVerifier: stored.value.joinMode === 'code' ? (joinCodeMetadata?.verifier ?? '') : undefined,
            joinCodeExpiresAtEpochMs: joinCodeMetadata?.expiresAtEpochMs
        })
    );
    const existing = read.targetMember ?? undefined;
    const role = command.input.participation === 'spectator'
        ? 'spectator'
        : command.input.participation === 'player' && existing?.role === 'spectator'
        ? 'member'
        : existing?.status === 'active'
        ? existing.role
        : 'member';
    if (existing?.status === 'active' && existing.role === role) {
        return noOp(command, read, facts);
    }
    const status = role === 'spectator' ? 'active' : resolveAdmittedMemberStatus({ read, facts, existing });
    if (existing?.status === 'active' && status === 'pending') {
        throw new GroupMutationRejectedError('Player promotion requires admission approval.');
    }
    if (existing?.status === 'pending' && status === 'pending') {
        return noOp(command, read, facts);
    }
    const audit = auditStamp(command, facts, command.targetPrincipalId);
    const member = createJoinedGroupMember({ command, existing, role, status, audit });
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [member],
        eventType: existing?.status === 'active' ? 'member-role-changed' : groupMemberEventType(status),
        publicationGrantEffects: []
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
        publicationGrantEffects: []
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
        publicationGrantEffects: []
    });
}

export function computeGovernedMember(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
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
        publicationGrantEffects: toDepartureGrantEffects(read, member)
    });
}

export function computeTransfer(
    command: Extract<GroupMutationCommand, { operation: 'transferGroupOwnership'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
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
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [
            { ...actor, role: 'admin', updated: audit },
            { ...target, role: 'owner', updated: audit }
        ],
        eventType: 'ownership-transferred',
        publicationGrantEffects: []
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
        capacity: facts.capacity
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
        publicationGrantEffects: toDepartureGrantEffects(read, member)
    });
}

/** A departure deletes the target's grant row in its own batch, so a rejoin never finds it again (D485). */
function toDepartureGrantEffects(
    read: GroupMutationRead,
    member: GroupMember
): readonly GroupPublicationGrantEffect[] {
    const grant = read.targetPublicationGrant;
    return grant === null || member.status === 'active'
        ? []
        : [{ operation: 'delete', value: grant.value, expectedRevision: grant.entry.revision }];
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
