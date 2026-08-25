import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
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
    if (read.lifecyclePolicy === null) {
        throw new TypeError('Lifecycle transition compute requires the policy read');
    }
    if (read.lifecyclePolicy.status === 'corrupt') {
        // Fail closed: an unreadable stored policy must not read as permissive.
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Group lifecycle policy is unreadable: ${read.lifecyclePolicy.reason}`
        });
    }
    const policy = read.lifecyclePolicy.status === 'present'
        ? read.lifecyclePolicy.policy
        : createDefaultGroupLifecyclePolicy();
    const transition = LIFECYCLE_TRANSITION_BY_OPERATION[command.operation];
    if (read.activeMemberPrincipalIds === null) {
        throw new TypeError('Lifecycle transition compute requires the roster read');
    }
    if (facts.internalAuthority === 'formation-criterion') {
        // The criterion evaluator petitions with service authority; the state
        // machine below is the only check that applies. Principals never carry
        // this authority mode (validateGroupMutationAuthority enforces it).
    }
    else if (command.operation === 'failGroupFormation') {
        throw new GroupMutationRejectedError('Formation failure is criterion-commanded only');
    }
    else {
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
    const outcome = computeGroupLifecycleTransition({
        transition,
        lifecycleState: stored.value.lifecycleState,
        formationEpoch: stored.value.formationEpoch
    });
    if (!outcome.allowed) {
        throw new GroupPolicyDeniedError(outcome);
    }
    const beginsEstablishment = command.operation === 'startGroupEstablishment' ||
        command.operation === 'reopenGroupEstablishment';
    const next: Group = {
        ...stored.value,
        lifecycleState: outcome.nextState,
        formationEpoch: outcome.nextFormationEpoch,
        establishmentStartedAtEpochMs: beginsEstablishment
            ? facts.nowEpochMs
            : command.operation === 'failGroupFormation'
            ? null
            : stored.value.establishmentStartedAtEpochMs,
        formationAttemptCount: command.operation === 'failGroupFormation'
            ? stored.value.formationAttemptCount + 1
            : stored.value.formationAttemptCount,
        lastFormationOutcome: computeRecordedOutcome(command, stored.value, facts),
        formationElectorate: read.activeMemberPrincipalIds,
        snapshotVersion: stored.value.snapshotVersion + 1,
        updated: auditStamp(command, facts, command.input.actorPrincipalId ?? undefined)
    };
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
