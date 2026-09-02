import { computeGroupAdmissionDecision } from '@shared/api/group-lifecycle/compute-group-admission-decision.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupMember } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { canActivateGroupMember, canDecideGroupAdmission } from '../../policy/group-membership-admission-policy.ts';
import { GroupPolicyDeniedError, type GroupPolicyActor } from '../../policy/group-policy-result.ts';
import { toPolicySnapshot } from '../aggregate/group-aggregate-mutation-policy.ts';
import {
    GroupMutationRejectedError,
    type GroupMutationCommand,
    type GroupMutationComputed,
    type GroupMutationFacts,
    type GroupMutationRead
} from '../group-mutation-contracts.ts';
import { auditStamp, noOp, requireGroup } from '../group-mutation-result.ts';
import { computeGroupMembershipWrite } from '../write/compute-group-membership-write.ts';
import { transitionGroupMemberLifecycle } from './transition-group-member-lifecycle.ts';

interface ComputeAdmittedMemberStatusInput {
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly existing: GroupMember | undefined;
}

/** Existing active membership is handled by the caller before asking admission. */
export function computeAdmittedMemberStatus(
    input: ComputeAdmittedMemberStatusInput
): Either<readonly GroupStateValidationIssue[], 'active' | 'pending'> {
    if (input.read.group === null) {
        return Either.ofLeft([{ path: 'read.group', cause: new GroupMutationRejectedError('Group not found') }]);
    }
    const resolution = computeAdmissionPolicy(input.read);
    if (resolution.left !== undefined) {
        return Either.ofLeft(resolution.left);
    }
    const policy = resolution.right!;
    const group = input.read.group.value;
    const decision = computeGroupAdmissionDecision({
        admission: policy.admission,
        lifecycleState: group.lifecycleState,
        activeMemberCount: group.activeMemberCount,
        invited: isUnexpiredInvite(input.existing, input.facts.nowEpochMs),
        nowEpochMs: input.facts.nowEpochMs
    });
    return decision.kind === 'deny'
        ? Either.ofLeft([{ path: 'read.lifecyclePolicy', cause: new GroupPolicyDeniedError(decision.denial) }])
        : Either.ofRight(decision.kind === 'park' ? 'pending' : 'active');
}

export function computeGrantGroupAdmission(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    requireGroup(read, command.aggregateRef);
    const resolution = computeAdmissionPolicy(read);
    if (resolution.left !== undefined) {
        return Either.ofLeft(resolution.left);
    }
    const policy = resolution.right!;
    const issues = [...validateAdmissionDecisionAuthority({ command, read, facts, policy })];
    const existing = read.targetMember;
    if (existing?.status === 'active') {
        return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(noOp(command, read, facts));
    }
    if (existing?.status !== 'pending') {
        issues.push({
            path: 'read.targetMember',
            cause: new GroupMutationRejectedError(`No pending admission for group member: ${command.targetPrincipalId}`)
        });
        return Either.ofLeft(issues);
    }
    const activation = canActivateGroupMember({
        snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
        targetPrincipalId: command.targetPrincipalId,
        nowEpochMs: facts.nowEpochMs,
        capacity: facts.capacity
    });
    if (!activation.allowed) {
        issues.push({ path: 'read.group', cause: new GroupPolicyDeniedError(activation) });
    }
    issues.push(...validateGroupAdmissionWindows(read, facts, policy));
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [transitionGroupMemberLifecycle({ ...existing, updated: audit }, 'active', audit)],
        eventType: 'member-joined'
    });
}

export function computeDeclineGroupAdmission(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    requireGroup(read, command.aggregateRef);
    const resolution = computeAdmissionPolicy(read);
    if (resolution.left !== undefined) {
        return Either.ofLeft(resolution.left);
    }
    const issues = validateAdmissionDecisionAuthority({ command, read, facts, policy: resolution.right! });
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const existing = read.targetMember;
    if (existing?.status !== 'pending') {
        return Either.ofRight(noOp(command, read, facts));
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    return computeGroupMembershipWrite({
        command,
        read,
        facts,
        members: [transitionGroupMemberLifecycle({ ...existing, updated: audit }, 'left', audit)],
        eventType: 'member-left'
    });
}

interface GroupAdmissionDecisionAuthorityInput {
    readonly command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly policy: GroupLifecyclePolicy;
}

function validateAdmissionDecisionAuthority(
    { command, read, facts, policy }: GroupAdmissionDecisionAuthorityInput
): readonly GroupStateValidationIssue[] {
    if (read.activeMemberPrincipalIds === null) {
        return [
            toGroupStateValidationIssue(
                'read.activeMemberPrincipalIds',
                'Admission decision compute requires the roster read'
            )
        ];
    }
    const decision = canDecideGroupAdmission({
        snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
        actor: toCommandActor(command),
        policy,
        activeMemberPrincipalIds: read.activeMemberPrincipalIds,
        nowEpochMs: facts.nowEpochMs
    });
    return decision.allowed ? [] : [{ path: 'read', cause: new GroupPolicyDeniedError(decision) }];
}

/** Consent bypasses parking, not the existing closed/deadline/capacity windows. */
export function validateGroupAdmissionWindows(
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    policy?: GroupLifecyclePolicy
): readonly GroupStateValidationIssue[] {
    if (read.group === null) {
        return [{ path: 'read.group', cause: new GroupMutationRejectedError('Group not found') }];
    }
    const resolution = policy === undefined
        ? computeAdmissionPolicy(read)
        : Either.ofRight<readonly GroupStateValidationIssue[], GroupLifecyclePolicy>(policy);
    if (resolution.left !== undefined) {
        return resolution.left;
    }
    const decision = computeGroupAdmissionDecision({
        admission: resolution.right!.admission,
        lifecycleState: read.group.value.lifecycleState,
        activeMemberCount: read.group.value.activeMemberCount,
        invited: true,
        nowEpochMs: facts.nowEpochMs
    });
    return decision.kind === 'deny'
        ? [{ path: 'read.lifecyclePolicy', cause: new GroupPolicyDeniedError(decision.denial) }]
        : [];
}

function computeAdmissionPolicy(
    read: GroupMutationRead
): Either<readonly GroupStateValidationIssue[], GroupLifecyclePolicy> {
    if (read.lifecyclePolicy === null) {
        return Either.ofLeft([
            toGroupStateValidationIssue('read.lifecyclePolicy', 'Admission compute requires the lifecycle policy read')
        ]);
    }
    if (read.lifecyclePolicy.status === 'corrupt') {
        return Either.ofLeft([{
            path: 'read.lifecyclePolicy',
            cause: new GroupMutationRejectedError(
                `Group lifecycle policy is unreadable: ${read.lifecyclePolicy.reason}`
            )
        }]);
    }
    return Either.ofRight(
        read.lifecyclePolicy.status === 'present'
            ? read.lifecyclePolicy.policy
            : createDefaultGroupLifecyclePolicy()
    );
}

function isUnexpiredInvite(existing: GroupMember | undefined, nowEpochMs: number): boolean {
    return existing?.status === 'invited' &&
        (existing.invitationExpiresAtEpochMs === null || existing.invitationExpiresAtEpochMs > nowEpochMs);
}

function toCommandActor(command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>): GroupPolicyActor {
    return {
        principalId: command.input.actorPrincipalId ?? undefined,
        sessionId: command.input.actorSessionId ?? undefined
    };
}
