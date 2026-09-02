import type { GroupMember } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { GroupStateValidationIssue } from '../../group-state-validation-issues.ts';

import { GroupPolicyDeniedError } from '../../policy/group-policy-result.ts';
import { canGovernGroupMutation, toPolicySnapshot } from '../aggregate/group-aggregate-mutation-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { auditStamp, noOp, requireGroup } from '../group-mutation-result.ts';
import { computeGroupMembershipWrite } from '../write/compute-group-membership-write.ts';
import { computeAdmittedMemberStatus, validateGroupAdmissionWindows } from './compute-group-admission-mutation.ts';
import {
    computeGovernedMemberEventType,
    computeGovernedMemberRole,
    computeGovernedMemberStatus,
    validateGovernedGroupMember,
    validateGroupInvite,
    validateGroupJoin,
    validateGroupOwnershipTransfer,
    validateMembershipRoleChange,
    validateRemainingGroupOwner,
    validateUpsertActivationAllowed,
    validateUpsertAuthority
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
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    const issues = validateGroupJoin(command, read, facts);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const existing = read.targetMember ?? undefined;
    if (existing?.status === 'active') {
        return Either.ofRight(noOp(command, read, facts));
    }
    const admission = computeAdmittedMemberStatus({ read, facts, existing });
    if (admission.left !== undefined) {
        return Either.ofLeft(admission.left);
    }
    const status = admission.right!;
    if (existing?.status === 'pending' && status === 'pending') {
        return Either.ofRight(noOp(command, read, facts));
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
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    requireGroup(read, command.aggregateRef);
    const issues = validateGroupInvite(command, read, facts);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const existing = read.targetMember ?? undefined;
    if (existing?.status === 'active') {
        return Either.ofRight(noOp(command, read, facts));
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
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    requireGroup(read, command.aggregateRef);
    const governance = canGovernGroupMutation({ command, read, facts, action: 'remove' });
    if (!governance.allowed) {
        return Either.ofLeft([{ path: 'read', cause: new GroupPolicyDeniedError(governance) }]);
    }
    const existing = read.targetMember ?? undefined;
    if (existing?.status !== 'invited') {
        return Either.ofRight(noOp(command, read, facts));
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
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    requireGroup(read, command.aggregateRef);
    const issues = validateGovernedGroupMember(command, read, facts);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const existing = read.targetMember ?? undefined;
    if (!existing && command.operation === 'unbanGroupMember') {
        return Either.ofRight(noOp(command, read, facts));
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
    const status = computeGovernedMemberStatus(command, base);
    const role = computeGovernedMemberRole(command, base);
    if (base.status === status && base.role === role) {
        return Either.ofRight(noOp(command, read, facts));
    }
    const member = transitionGroupMemberLifecycle(
        {
            ...base,
            role,
            updated: audit
        },
        status,
        audit
    );
    const eventType = computeGovernedMemberEventType(command);
    return computeGroupMembershipWrite({ command, read, facts, members: [member], eventType });
}

export function computeTransfer(
    command: Extract<GroupMutationCommand, { operation: 'transferGroupOwnership'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    requireGroup(read, command.aggregateRef);
    const issues = validateGroupOwnershipTransfer(command, read, facts);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const actor = read.actorMember as GroupMember;
    const target = read.targetMember as GroupMember;
    if (actor.principalId === target.principalId) {
        return Either.ofRight(noOp(command, read, facts));
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
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    requireGroup(read, command.aggregateRef);
    const isSelf = command.input.actorPrincipalId === command.targetPrincipalId;
    const issues = [
        ...validateUpsertAuthority({ command, read, facts, isSelf }),
        ...validateMembershipRoleChange(command.input.role, read, isSelf),
        ...validateUpsertActivationAllowed({
            command,
            snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
            nowEpochMs: facts.nowEpochMs,
            capacity: facts.capacity
        })
    ];
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const projection = computeUpsertMemberProjection({ command, read, facts, isSelf });
    if (projection.left !== undefined) {
        return Either.ofLeft(projection.left);
    }
    const member = projection.right!;
    if (member === null) {
        return Either.ofRight(noOp(command, read, facts));
    }
    const ownerIssues = validateRemainingGroupOwner({
        group: requireGroup(read, command.aggregateRef).value,
        existing: read.targetMember ?? undefined,
        nextStatus: member.status,
        nextRole: member.role
    });
    if (ownerIssues.length > 0) {
        return Either.ofLeft(ownerIssues);
    }
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [member],
        eventType: groupMemberEventType(member.status)
    });
}

interface GroupMemberUpsertProjectionInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'upsertMember'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly isSelf: boolean;
}

function computeUpsertMemberProjection(
    { command, read, facts, isSelf }: GroupMemberUpsertProjectionInput
): Either<readonly GroupStateValidationIssue[], GroupMember | null> {
    const existing = read.targetMember ?? undefined;
    // Existing active membership bypasses admission; self-activation and governance grants do not.
    const admission = isSelf && command.input.status === 'active' && existing?.status !== 'active'
        ? computeAdmittedMemberStatus({ read, facts, existing })
        : Either.ofRight<readonly GroupStateValidationIssue[], GroupMember['status']>(command.input.status);
    if (admission.left !== undefined) {
        return Either.ofLeft(admission.left);
    }
    const status = admission.right!;
    if (!isSelf && status === 'active' && existing?.status !== 'active') {
        const issues = validateGroupAdmissionWindows(read, facts);
        if (issues.length > 0) {
            return Either.ofLeft(issues);
        }
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
        return Either.ofRight(null);
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
    return Either.ofRight(existing && jsonEquals(existing, member) ? null : member);
}
