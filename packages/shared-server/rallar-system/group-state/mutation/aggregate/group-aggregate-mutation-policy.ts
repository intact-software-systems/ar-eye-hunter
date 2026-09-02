import { resolveRallarGroupDirectorAppointmentEligibility } from '@shared/api/group-director.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    computeGroupLifecycleTransition,
    denyExhaustedFormationSeries,
    type GroupLifecycleTransition,
    type GroupLifecycleTransitionOutcome
} from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import { validateGroupLifecyclePolicy } from '@shared/api/group-lifecycle/validate-group-lifecycle-policy.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';

import type { GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { canGovernGroupMember, type GroupGovernanceAction } from '../../policy/group-governance-policy.ts';
import {
    canCommandGroupAuthority,
    canCommandGroupLifecycleTransition,
    canMutateActiveGroup,
    type CanCommandGroupAuthorityInput
} from '../../policy/group-lifecycle-policy.ts';
import { GROUP_POLICY_ALLOWED, GroupPolicyDeniedError } from '../../policy/group-policy-result.ts';
import { validateInitialGroupSnapshotPredecessor } from '../../presence/group-initial-presence-summary.ts';
import {
    GroupMutationRejectedError,
    type GroupLifecycleTransitionOperation,
    type GroupMutationCommand,
    type GroupMutationFacts,
    type GroupMutationRead
} from '../group-mutation-contracts.ts';
import type { GroupMutationRejectionCode } from '../group-mutation-rejection-codes.ts';
import { currentCausalRevision, requireGroup, validateRequiredGroup } from '../group-mutation-result.ts';
import { computeLifecycleFenceRejection } from './compute-lifecycle-fence-rejection.ts';
import { resolveGroupAuthorityPolicy } from './resolve-group-authority-policy.ts';

export const GROUP_LIFECYCLE_TRANSITION_BY_OPERATION = {
    planGroupLayout: 'plan',
    connectGroup: 'connect',
    startGroupFormation: 'start',
    resetGroupFormation: 'reset',
    activateGroup: 'activate',
    reconfigureGroup: 'reconfigure',
    failGroupFormation: 'fail-formation'
} as const satisfies Record<GroupLifecycleTransitionOperation, GroupLifecycleTransition>;

interface GroupMutationGovernanceInput {
    readonly command:
        | Extract<GroupMutationCommand, { targetPrincipalId: string; }>
        | Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly action: GroupGovernanceAction;
}

interface GroupAuthorityPolicyInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly policy: GroupLifecyclePolicy;
}

interface GroupLifecycleTransitionAuthorityInput extends GroupAuthorityPolicyInput {
    readonly command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>;
    readonly transition: GroupLifecycleTransition;
}

interface ValidateGroupUpdateInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'updateGroup'; }>;
    readonly group: Group;
    readonly actorMember: GroupMember | null;
    readonly nowEpochMs: number;
}

interface GroupCreationRejection {
    readonly rejectionCode: Exclude<GroupMutationRejectionCode, 'group-policy-denied'>;
    readonly message: string;
}

export function validateGroupAggregateMutationPolicy(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    if (read.idempotency !== null) {
        return [];
    }
    if (command.operation === 'createGroup') {
        return computeGroupCreationRejection(command, read) === null
            ? validateInitialGroupSnapshotPredecessor(read.expiredGroupEntry, read.presenceSummary)
            : [];
    }
    const issues = validateRequiredGroup(read, command.aggregateRef);
    if (read.group === null) {
        return issues;
    }
    switch (command.operation) {
        case 'updateGroup':
            return validateGroupUpdate({
                command,
                group: read.group.value,
                actorMember: read.actorMember,
                nowEpochMs: facts.nowEpochMs
            });
        case 'rotateGroupJoinCode': {
            const decision = canGovernGroupMutation({ command, read, facts, action: 'invite' });
            return decision.allowed ? [] : [{ path: 'read', cause: new GroupPolicyDeniedError(decision) }];
        }
        case 'planGroupLayout':
        case 'connectGroup':
        case 'startGroupFormation':
        case 'resetGroupFormation':
        case 'activateGroup':
        case 'reconfigureGroup':
        case 'failGroupFormation':
            return validateGroupAuthorityMutation(command, read, facts);
        case 'pauseGroupTransport':
        case 'resumeGroupTransport':
            return validateGroupAuthorityMutation(command, read, facts);
        case 'appointDirector':
            return validateGroupDirectorAppointment(command, read, facts);
        case 'applyPlannedLayout':
        case 'heartbeatPresence':
            return validateActiveGroup(read.group.value, facts.nowEpochMs);
        default:
            return issues;
    }
}

export function computeGroupCreationRejection(
    command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>,
    read: GroupMutationRead
): GroupCreationRejection | null {
    if (command.input.actorPrincipalId !== command.input.createdByPrincipalId) {
        return {
            rejectionCode: 'group-mutation-rejected',
            message: 'Creator authority does not match createdByPrincipalId'
        };
    }
    if (read.group !== null) {
        return {
            rejectionCode: 'group-already-exists',
            message: `Group already exists: ${command.aggregateRef.groupId}`
        };
    }
    const policyIssues = command.input.lifecyclePolicy === undefined
        ? []
        : (validateGroupLifecyclePolicy(command.input.lifecyclePolicy).left ?? []);
    if (policyIssues.length > 0) {
        return {
            rejectionCode: 'group-mutation-rejected',
            message: `Group lifecycle policy is not coherent: ${
                policyIssues.map((issue) => `${issue.field} ${issue.code}`).join('; ')
            }`
        };
    }
    return null;
}

export function validateGroupDirectorAppointment(
    command: Extract<GroupMutationCommand, { operation: 'appointDirector'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    if (read.group === null) {
        return validateRequiredGroup(read, command.aggregateRef);
    }
    const issues = [...validateActiveGroup(read.group.value, facts.nowEpochMs)];
    const principalId = command.input.actorPrincipalId;
    const sessionId = command.input.actorSessionId;
    if (!principalId || !sessionId) {
        return [...issues, {
            path: 'command.input',
            cause: new GroupMutationRejectedError('Forbidden: Cannot appoint a director without a local session.')
        }];
    }
    const eligibility = resolveRallarGroupDirectorAppointmentEligibility({
        snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
        principalId,
        sessionId
    });
    if (!eligibility.allowed) {
        issues.push({
            path: 'read',
            cause: new GroupMutationRejectedError(
                `Forbidden: ${eligibility.reason ?? 'Cannot appoint the browser director.'}`
            )
        });
    }
    return issues;
}

function validateGroupAuthorityMutation(
    command: Extract<
        GroupMutationCommand,
        { operation: GroupLifecycleTransitionOperation | 'pauseGroupTransport' | 'resumeGroupTransport'; }
    >,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    if (read.group === null) {
        return validateRequiredGroup(read, command.aggregateRef);
    }
    const issues = validateActiveGroup(read.group.value, facts.nowEpochMs);
    if (issues.length > 0) {
        return issues;
    }
    const resolution = resolveGroupAuthorityPolicy(read);
    if (resolution.status === 'corrupt') {
        return [];
    }
    switch (command.operation) {
        case 'pauseGroupTransport':
        case 'resumeGroupTransport':
            return validateGroupTransportAuthority({ command, read, facts, policy: resolution.policy });
        default: {
            const transition = GROUP_LIFECYCLE_TRANSITION_BY_OPERATION[command.operation];
            const authorityIssues = validateLifecycleTransitionAuthority({
                command,
                read,
                facts,
                policy: resolution.policy,
                transition
            });
            if (authorityIssues.length > 0 || facts.internalAuthority !== 'formation-criterion') {
                return authorityIssues;
            }
            if (computeLifecycleFenceRejection({ command, read, facts, stored: read.group.value }) !== null) {
                return [];
            }
            const outcome = computeGroupLifecycleMutationDecision(transition, read.group.value, resolution.policy);
            return outcome.allowed ? [] : [{ path: 'read.group', cause: new GroupPolicyDeniedError(outcome) }];
        }
    }
}

export function computeGroupLifecycleMutationDecision(
    transition: GroupLifecycleTransition,
    stored: Group,
    policy: GroupLifecyclePolicy
): GroupLifecycleTransitionOutcome {
    const outcome = computeGroupLifecycleTransition({
        transition,
        lifecycleState: stored.lifecycleState,
        formationEpoch: stored.formationEpoch
    });
    if (!outcome.allowed) {
        return outcome;
    }
    return denyExhaustedFormationSeries({
        transition,
        activation: policy.activation,
        formationAttemptCount: stored.formationAttemptCount
    }) ?? outcome;
}

export function validateLifecycleTransitionAuthority(
    input: GroupLifecycleTransitionAuthorityInput
): readonly GroupStateValidationIssue[] {
    if (
        input.facts.internalAuthority === 'formation-criterion' ||
        input.facts.internalAuthority === 'formation-automation'
    ) {
        return [];
    }
    if (input.command.operation === 'failGroupFormation') {
        return [{
            path: 'command.operation',
            cause: new GroupMutationRejectedError('Formation failure is criterion-commanded only')
        }];
    }
    const decision = canCommandGroupLifecycleTransition({
        ...toGroupAuthorityPolicyInput(input),
        transition: input.transition
    });
    return decision.allowed ? [] : [{ path: 'read', cause: new GroupPolicyDeniedError(decision) }];
}

export function validateGroupTransportAuthority(
    input: GroupAuthorityPolicyInput
): readonly GroupStateValidationIssue[] {
    const decision = canCommandGroupAuthority(toGroupAuthorityPolicyInput(input));
    return decision.allowed ? [] : [{ path: 'read', cause: new GroupPolicyDeniedError(decision) }];
}

export function validateGroupUpdate(input: ValidateGroupUpdateInput): readonly GroupStateValidationIssue[] {
    const decision = canUpdateGroup(input);
    const issues: GroupStateValidationIssue[] = decision.allowed
        ? []
        : [{ path: 'read', cause: new GroupPolicyDeniedError(decision) }];
    const maxMembers = input.command.input.maxMembers ?? input.group.maxMembers;
    if (maxMembers !== null && maxMembers < input.group.activeMemberCount) {
        issues.push({
            path: 'command.input.maxMembers',
            cause: new GroupMutationRejectedError('Group maxMembers cannot be lower than activeMemberCount.')
        });
    }
    return issues;
}

function canUpdateGroup(input: ValidateGroupUpdateInput): GroupPolicyResult {
    const { command, group, actorMember, nowEpochMs } = input;
    if (
        !command.input.actorPrincipalId ||
        actorMember?.principalId !== command.input.actorPrincipalId ||
        actorMember.status !== 'active' ||
        (actorMember.role !== 'owner' && actorMember.role !== 'admin')
    ) {
        return {
            allowed: false,
            code: 'forbidden-role',
            message: 'Only active group owners/admins can update groups.'
        };
    }
    return group.status === 'archived' && command.input.status === 'deleted'
        ? GROUP_POLICY_ALLOWED
        : canMutateActiveGroup({ group, nowEpochMs });
}

export function toPolicySnapshot(
    read: GroupMutationRead,
    ref: GroupRef,
    nowEpochMs: number
): GroupSnapshot {
    const stored = requireGroup(read, ref);
    const members = [read.actorMember, read.targetMember, read.authorityMember, read.directorMember]
        .filter((member): member is GroupMember => member !== null)
        .filter(
            (member, index, values) =>
                values.findIndex((candidate) => candidate.principalId === member.principalId) === index
        );
    const targetSessions = read.targetPresence &&
            read.targetPresence.value.disconnectedAtEpochMs === null &&
            read.targetPresence.value.expiresAtEpochMs > nowEpochMs &&
            isExactlyAdmitted(read.targetAdmission?.value, read.targetPresence.value)
        ? [read.targetPresence.value]
        : [];
    const authoritySessions = read.authorityPresenceSessions.filter(
        (session) =>
            session.disconnectedAtEpochMs === null &&
            session.expiresAtEpochMs > nowEpochMs &&
            (isExactlyAdmitted(read.authorityAdmission?.value, session) ||
                isExactlyAdmitted(read.directorAdmission?.value, session))
    );
    const activeSessions = [...targetSessions, ...authoritySessions].filter(
        (session, index, sessions) =>
            sessions.findIndex(
                (candidate) =>
                    candidate.sessionId === session.sessionId &&
                    candidate.generationId === session.generationId &&
                    candidate.generationVersion === session.generationVersion
            ) === index
    );
    const activePrincipals = new Set(activeSessions.map((session) => session.principalId));
    const causalRevision = currentCausalRevision(read);
    return {
        causalRevision,
        group: {
            ...stored.value,
            presenceVersion: causalRevision.presenceRevision
        },
        members,
        activeSessions,
        memberCount: stored.value.activeMemberCount,
        onlineMemberCount: members.filter(
            (member) => member.status === 'active' && activePrincipals.has(member.principalId)
        ).length
    };
}

/**
 * The one construction of the group-authority policy question (product
 * decision 12). Both families ask it: the transitions add their transition to
 * the result, the transport valve asks it as it stands.
 */
export function toGroupAuthorityPolicyInput(
    input: GroupAuthorityPolicyInput
): CanCommandGroupAuthorityInput {
    const { command, read, facts, policy } = input;
    if (read.activeMemberPrincipalIds === null) {
        throw new TypeError('Group authority compute requires the roster read');
    }
    return {
        snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
        actor: {
            principalId: command.input.actorPrincipalId ?? undefined,
            sessionId: command.input.actorSessionId ?? undefined
        },
        policy,
        activeMemberPrincipalIds: read.activeMemberPrincipalIds
    };
}

export function assertActive(group: Group, nowEpochMs: number): void {
    const issues = validateActiveGroup(group, nowEpochMs);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
}

export function validateActiveGroup(group: Group, nowEpochMs: number): readonly GroupStateValidationIssue[] {
    const decision = canMutateActiveGroup({ group, nowEpochMs });
    return decision.allowed ? [] : [{ path: 'read.group', cause: new GroupPolicyDeniedError(decision) }];
}

export function assertPrincipalAuthority(command: GroupMutationCommand, principalId: string): void {
    const issues = validatePrincipalAuthority(command, principalId);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
}

export function validatePrincipalAuthority(
    command: GroupMutationCommand,
    principalId: string
): readonly GroupStateValidationIssue[] {
    if (command.input.actorPrincipalId !== principalId) {
        return [{
            path: 'command.input.actorPrincipalId',
            cause: new GroupPolicyDeniedError({
                allowed: false,
                code: 'member-not-active',
                message: 'Mutation actor must match the authoritative principal.'
            })
        }];
    }
    return [];
}

export function assertGovernance(input: GroupMutationGovernanceInput): void {
    assertAllowed(canGovernGroupMutation(input));
}

export function canGovernGroupMutation(input: GroupMutationGovernanceInput): GroupPolicyResult {
    const { action, command, facts, read } = input;
    const stored = requireGroup(read, command.aggregateRef);
    const active = canMutateActiveGroup({ group: stored.value, nowEpochMs: facts.nowEpochMs });
    return active.allowed
        ? canGovernGroupMember({
            snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
            actor: {
                principalId: command.input.actorPrincipalId ?? undefined,
                sessionId: command.input.actorSessionId ?? undefined
            },
            targetPrincipalId: 'targetPrincipalId' in command
                ? command.targetPrincipalId
                : `${command.aggregateRef.groupId}:join-code`,
            action
        })
        : active;
}

export function assertAllowed(result: GroupPolicyResult): void {
    if (result.allowed) {
        return;
    }
    throw new GroupPolicyDeniedError(result);
}

export function isExactlyAdmitted(
    admission: GroupPresenceAdmission | undefined,
    session: GroupPresenceSession
): boolean {
    return (
        admission?.principalId === session.principalId &&
        admission.admittedSessions.some(
                (entry) =>
                    entry.sessionId === session.sessionId &&
                    entry.generationId === session.generationId &&
                    entry.generationVersion === session.generationVersion
            ) === true
    );
}
