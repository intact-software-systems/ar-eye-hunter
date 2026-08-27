import { computeExpectedLayoutFence } from '@shared/api/group-lifecycle/compute-expected-layout-fence.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    computeGroupLifecycleTransition,
    type GroupLifecycleTransition
} from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { Group } from '@shared/api/group-types.ts';

import { computeFormationTimerEntries } from '../../formation-timer-outbox-entry.ts';
import { canCommandGroupLifecycleTransition } from '../../policy/group-lifecycle-policy.ts';
import { GroupPolicyDeniedError } from '../../policy/group-policy-result.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import type {
    GroupLifecycleTransitionOperation,
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { auditStamp, computeGroupMutationWriteResult, rejected, requireGroup } from '../group-mutation-result.ts';
import { assertActive, assertAllowed, toPolicySnapshot } from './group-aggregate-mutation-policy.ts';

const LIFECYCLE_TRANSITION_BY_OPERATION = {
    startGroupEstablishment: 'start-establishment',
    activateGroup: 'activate',
    reopenGroupEstablishment: 'reopen-establishment',
    failGroupFormation: 'fail-formation'
} as const satisfies Record<GroupLifecycleTransitionOperation, GroupLifecycleTransition>;

function computeRecordedOutcome(
    command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>,
    stored: Group,
    facts: GroupMutationFacts
): Group['lastFormationOutcome'] {
    if (command.operation === 'failGroupFormation') {
        return {
            outcome: 'below-floor',
            observedRate: command.input.observedRate,
            atEpochMs: facts.nowEpochMs,
            formationEpoch: stored.formationEpoch
        };
    }
    if (command.operation === 'activateGroup' && command.input.observedRate !== null) {
        return {
            outcome: command.input.degraded === true ? 'activated-degraded' : 'activated',
            observedRate: command.input.observedRate,
            atEpochMs: facts.nowEpochMs,
            formationEpoch: stored.formationEpoch
        };
    }
    return stored.lastFormationOutcome;
}

export function computeLifecycleTransition(
    command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertActive(stored.value, facts.nowEpochMs);
    const corruptPolicyRejection = computeCorruptPolicyRejection({ command, read, facts });
    if (corruptPolicyRejection !== null) {
        return corruptPolicyRejection;
    }
    const policy = read.lifecyclePolicy?.status === 'present'
        ? read.lifecyclePolicy.policy
        : createDefaultGroupLifecyclePolicy();
    const transition = LIFECYCLE_TRANSITION_BY_OPERATION[command.operation];
    if (read.activeMemberPrincipalIds === null) {
        throw new TypeError('Lifecycle transition compute requires the roster read');
    }
    // The fence is keyed on fence presence, never on who produced the command:
    // any lifecycle command naming stale causal expectations is rejected,
    // and unfenced (principal) commands pass through untouched.
    const fenceRejection = computeFenceRejection({ command, read, facts, stored: stored.value });
    if (fenceRejection !== null) {
        return fenceRejection;
    }
    validateLifecycleTransitionAuthority({ command, read, facts, policy, transition });
    const outcome = computeGroupLifecycleTransition({
        transition,
        lifecycleState: stored.value.lifecycleState,
        formationEpoch: stored.value.formationEpoch
    });
    if (!outcome.allowed) {
        throw new GroupPolicyDeniedError(outcome);
    }
    const next = computeNextLifecycleGroup({
        command,
        facts,
        stored: stored.value,
        outcome,
        formationElectorate: read.activeMemberPrincipalIds
    });
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            operation: 'update',
            value: next,
            expectedRevision: stored.entry.revision
        },
        members: [],
        initialPresenceSummary: null,
        presenceAdmission: null,
        eventType: 'group-updated',
        presenceSummaryWork: 'enqueue',
        extraOutboxEntries: computeFormationTimerEntries({ command, next, policy, facts })
    });
}

function computeCorruptPolicyRejection(
    { command, read, facts }: LifecycleTransitionDecisionInput
): GroupMutationComputed | null {
    if (read.lifecyclePolicy === null) {
        throw new TypeError('Lifecycle transition compute requires the policy read');
    }
    if (read.lifecyclePolicy.status !== 'corrupt') {
        return null;
    }
    // Fail closed: an unreadable stored policy must not read as permissive.
    return rejected({
        command,
        read,
        facts,
        rejectionCode: 'group-mutation-rejected',
        message: `Group lifecycle policy is unreadable: ${read.lifecyclePolicy.reason}`
    });
}

function computeNextLifecycleGroup(
    { command, facts, stored, outcome, formationElectorate }: Readonly<{
        command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>;
        facts: GroupMutationFacts;
        stored: Group;
        outcome: Extract<ReturnType<typeof computeGroupLifecycleTransition>, { allowed: true; }>;
        formationElectorate: readonly string[];
    }>
): Group {
    const beginsEstablishment = command.operation === 'startGroupEstablishment' ||
        command.operation === 'reopenGroupEstablishment';
    return {
        ...stored,
        lifecycleState: outcome.nextState,
        formationEpoch: outcome.nextFormationEpoch,
        establishmentStartedAtEpochMs: beginsEstablishment
            ? facts.nowEpochMs
            : command.operation === 'failGroupFormation'
            ? null
            : stored.establishmentStartedAtEpochMs,
        formationAttemptCount: command.operation === 'failGroupFormation'
            ? stored.formationAttemptCount + 1
            : stored.formationAttemptCount,
        lastFormationOutcome: computeRecordedOutcome(command, stored, facts),
        formationElectorate,
        snapshotVersion: stored.snapshotVersion + 1,
        updated: auditStamp(command, facts, command.input.actorPrincipalId ?? undefined)
    };
}

interface LifecycleTransitionDecisionInput {
    readonly command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
}

/**
 * The criterion evaluator petitions with service authority, so the causal
 * fence and the state machine are its only checks; principal commands answer
 * to the initiator policy, and formation failure has no principal route.
 */
function validateLifecycleTransitionAuthority(
    { command, read, facts, policy, transition }:
        & LifecycleTransitionDecisionInput
        & Readonly<{
            policy: GroupLifecyclePolicy;
            transition: GroupLifecycleTransition;
        }>
): void {
    if (facts.internalAuthority === 'formation-criterion') {
        return;
    }
    if (command.operation === 'failGroupFormation') {
        throw new GroupMutationRejectedError('Formation failure is criterion-commanded only');
    }
    if (read.activeMemberPrincipalIds === null) {
        throw new TypeError('Lifecycle transition compute requires the roster read');
    }
    assertAllowed(
        canCommandGroupLifecycleTransition({
            snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
            actor: {
                principalId: command.input.actorPrincipalId ?? undefined,
                sessionId: command.input.actorSessionId ?? undefined
            },
            policy,
            transition,
            activeMemberPrincipalIds: read.activeMemberPrincipalIds
        })
    );
}

/**
 * The causal fence (product decisions 19 and 32): a command carrying an old
 * epoch, a layout identity that is no longer the stored plan, or a removed
 * layout as an activation target is a typed rejection that writes no state,
 * event, or receipt effect — never a wrong transition and never a silent
 * no-op. Unfenced (principal) commands pass; absent, like null, means no
 * fence, though the wire decoders reject absent keys before compute.
 */
function computeFenceRejection(
    { command, read, facts, stored }: LifecycleTransitionDecisionInput & Readonly<{ stored: Group; }>
): GroupMutationComputed | null {
    const rejectedFence = (message: string) =>
        rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message });
    const expectedFormationEpoch = command.input.expectedFormationEpoch ?? null;
    if (expectedFormationEpoch !== null && expectedFormationEpoch !== stored.formationEpoch) {
        return rejectedFence(
            `Criterion petition fence is stale-epoch: expected ${expectedFormationEpoch}, ` +
                `stored ${stored.formationEpoch}`
        );
    }
    const expectedLayout = command.operation === 'activateGroup' ||
            command.operation === 'failGroupFormation'
        ? command.input.expectedLayout ?? null
        : null;
    if (expectedLayout === null) {
        return null;
    }
    if (expectedFormationEpoch === null) {
        return rejectedFence('Criterion petition carries a layout fence without an epoch fence');
    }
    if (command.operation === 'activateGroup' && expectedLayout.state !== 'active') {
        return rejectedFence('Criterion activation fence names a removed layout');
    }
    const fence = computeExpectedLayoutFence({
        expectedFormationEpoch,
        expectedLayout,
        currentFormationEpoch: stored.formationEpoch,
        currentPlannedLayout: read.plannedLayoutIdentity ?? undefined
    });
    if (fence === 'match') {
        return null;
    }
    return rejectedFence(`Criterion petition fence is ${fence} for the stored planned layout`);
}
