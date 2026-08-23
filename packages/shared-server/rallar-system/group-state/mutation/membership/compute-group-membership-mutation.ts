import { canJoinGroup } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { GroupEventType, GroupMember } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

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
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { auditStamp, noOp, requireGroup } from '../group-mutation-result.ts';
import { computeGroupMembershipWrite } from '../write/compute-group-membership-write.ts';
import { assertGroupAdmissionWindowsOpen, resolveAdmittedMemberStatus } from './compute-group-admission-mutation.ts';
import {
    assertUpsertActivationAllowed,
    assertUpsertAuthority,
    assertUpsertRoleChange,
    governanceActionFor,
    governedMemberEventType,
    governedMemberRole,
    governedMemberStatus
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
    const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs);
    const joinCodeMetadata = readJoinCode(stored.value.metadata);
    assertAllowed(
        canJoinGroup({
            snapshot,
            actor: {
                principalId: command.input.actorPrincipalId ?? undefined,
                sessionId: command.input.actorSessionId ?? undefined
            },
            nowEpochMs: facts.nowEpochMs,
            capacity: facts.capacity,
            inviteToken: command.input.inviteToken ?? undefined,
            joinCode: command.input.joinCode ?? undefined,
            joinCodeVerifier: facts.joinCodeVerifier ?? undefined,
            expectedJoinCodeVerifier: stored.value.joinMode === 'code' ? (joinCodeMetadata?.verifier ?? '') : undefined,
            joinCodeExpiresAtEpochMs: joinCodeMetadata?.expiresAtEpochMs
        })
    );
    const existing = read.targetMember ?? undefined;
    if (existing?.status === 'active') {
        return noOp(command, read, facts);
    }
    const status = resolveAdmittedMemberStatus({ read, facts, existing });
    if (existing?.status === 'pending' && status === 'pending') {
        return noOp(command, read, facts);
    }
    const audit = auditStamp(command, facts, command.targetPrincipalId);
    const member: GroupMember = {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: existing?.role ?? 'member',
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
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [member],
        eventType: groupMemberEventType(status)
    });
}

export function computeInvite(
    command: Extract<GroupMutationCommand, { operation: 'createGroupInvite'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance({ command, read, facts, action: 'invite' });
    const existing = findTargetMember(read);
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
            facts.nowEpochMs + DEFAULT_GROUP_INVITE_TTL_MS
    };
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [member],
        eventType: 'member-invited'
    });
}

export function computeRevokeInvite(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance({ command, read, facts, action: 'remove' });
    const existing = findTargetMember(read);
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
        eventType: 'member-left'
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
    const existing = findTargetMember(read);
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
    return computeGroupMembershipWrite({ command, read, facts, members: [member], eventType });
}

export function computeTransfer(
    command: Extract<GroupMutationCommand, { operation: 'transferGroupOwnership'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance({ command, read, facts, action: 'transfer-ownership' });
    const actor = read.actorMember ?? undefined;
    const target = findTargetMember(read);
    if (!actor || actor.status !== 'active' || actor.role !== 'owner') {
        throw new GroupMutationRejectedError('Only an active owner can transfer ownership.');
    }
    if (!target || target.status !== 'active') {
        throw new GroupMutationRejectedError('Ownership target must be active.');
    }
    if (actor.principalId === target.principalId) {
        return noOp(command, read, facts);
    }
    const audit = auditStamp(command, facts, actor.principalId);
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [
            { ...actor, role: 'admin', updated: audit },
            { ...target, role: 'owner', updated: audit }
        ],
        eventType: 'ownership-transferred'
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
    const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs);
    assertUpsertActivationAllowed({
        command,
        snapshot,
        nowEpochMs: facts.nowEpochMs,
        capacity: facts.capacity
    });
    const existing = findTargetMember(read);
    // Self-activation is the second join surface: it takes the same admission
    // decision as the join command, so it parks where a join would park
    // (plan decision 5.1). Admin activation stays governance — it is a grant
    // expressed through the existing surface. An already-active member is not
    // joining: their re-upsert bypasses admission exactly as computeJoin's
    // active no-op does, never demoting or re-gating an existing membership.
    const status = isSelf && command.input.status === 'active' && existing?.status !== 'active'
        ? resolveAdmittedMemberStatus({ read, facts, existing })
        : command.input.status;
    // Governance activation is the group's consent, but the admission windows
    // and the closed mode still bind — the same re-check grant runs.
    if (!isSelf && status === 'active' && existing?.status !== 'active') {
        assertGroupAdmissionWindowsOpen(read, facts);
    }
    const role = command.input.role ?? existing?.role ?? 'member';
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
    if (existing && jsonEquals(existing, member)) {
        return noOp(command, read, facts);
    }
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
        eventType: groupMemberEventType(member.status)
    });
}

function findTargetMember(read: GroupMutationRead): GroupMember | undefined {
    return read.targetMember ?? undefined;
}
