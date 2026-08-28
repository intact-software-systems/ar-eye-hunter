import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    computeGroupLifecycleTransition,
    type GroupLifecycleTransition
} from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import { beginsGroupEstablishmentAt } from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';
import type { Group } from '@shared/api/group-types.ts';

import { computeFormationTimerEntries } from '../../formation-timer-outbox-entry.ts';
import { canCommandGroupLifecycleTransition } from '../../policy/group-lifecycle-policy.ts';
import { GroupPolicyDeniedError } from '../../policy/group-policy-result.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import {
    GroupLayoutTombstones,
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead,
    isLayoutFencedGroupMutationCommand,
    type GroupLifecycleTransitionOperation
} from '../group-mutation-contracts.ts';
import { auditStamp, computeGroupMutationWriteResult, requireGroup } from '../group-mutation-result.ts';
import { computeLifecycleFenceRejection } from './compute-lifecycle-fence-rejection.ts';
import {
    computePlannedLayoutPromotion,
    type GroupPlannedLayoutRow,
    type PlannedLayoutPromotion
} from './compute-planned-layout-promotion.ts';
import { assertActive, assertAllowed, toGroupAuthorityPolicyInput } from './group-aggregate-mutation-policy.ts';
import { resolveGroupAuthorityPolicy, toCorruptPolicyRejection } from './resolve-group-authority-policy.ts';

const LIFECYCLE_TRANSITION_BY_OPERATION = {
    startGroupEstablishment: 'start-establishment',
    planGroupLayout: 'plan',
    connectGroup: 'connect',
    startGroupFormation: 'start',
    resetGroupFormation: 'reset',
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
    const resolution = resolveGroupAuthorityPolicy(read);
    if (resolution.status === 'corrupt') {
        return toCorruptPolicyRejection({ command, read, facts, reason: resolution.reason });
    }
    const policy = resolution.policy;
    const transition = LIFECYCLE_TRANSITION_BY_OPERATION[command.operation];
    if (read.activeMemberPrincipalIds === null) {
        throw new TypeError('Lifecycle transition compute requires the roster read');
    }
    // Authority first: the fence's answer names the stored plan, so a
    // caller who may not command the transition must not read it.
    validateLifecycleTransitionAuthority({ command, read, facts, policy, transition });
    const fenceRejection = computeLifecycleFenceRejection({ command, read, facts, stored: stored.value });
    if (fenceRejection !== null) {
        return fenceRejection;
    }
    const outcome = computeGroupLifecycleTransition({
        transition,
        lifecycleState: stored.value.lifecycleState,
        formationEpoch: stored.value.formationEpoch
    });
    if (!outcome.allowed) {
        throw new GroupPolicyDeniedError(outcome);
    }
    const promotion = computeActivationPromotion(command, read, stored.value);
    const next = computeNextLifecycleGroup({
        command,
        facts,
        stored: stored.value,
        outcome,
        formationElectorate: read.activeMemberPrincipalIds,
        promotion
    });
    return computeGroupMutationWriteResult({
        layoutTombstones: computeLayoutTombstones(command, read),
        acceptedLayoutPromotion: promotion?.outcome === 'apply' ? promotion : null,
        // A promotion already re-asserts the planned row. `connect` dials a
        // candidate without promoting it (decision 42), so it carries the
        // guard itself and a replan landing between the read and the commit
        // conflicts the batch instead of dialing a superseded candidate
        // (decisions 19/32). A fenced formation failure deliberately keeps
        // today's behavior: it discards the plan rather than binding to it,
        // so guarding the row would only make a concurrent replan retry it.
        plannedLayoutFence: command.operation === 'connectGroup' && command.input.expectedLayout !== null
            ? read.plannedLayoutRow
            : null,
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

function computeNextLifecycleGroup(
    { command, facts, stored, outcome, formationElectorate, promotion }: Readonly<{
        command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>;
        facts: GroupMutationFacts;
        stored: Group;
        outcome: Extract<ReturnType<typeof computeGroupLifecycleTransition>, { allowed: true; }>;
        formationElectorate: readonly string[];
        promotion: PlannedLayoutPromotion | null;
    }>
): Group {
    if (command.operation === 'resetGroupFormation') {
        return toClearedFormationSeries({ command, facts, stored, outcome, formationElectorate });
    }
    const acceptedLayoutIdentity = promotion?.outcome === 'apply'
        ? promotion.acceptedIdentity
        : stored.acceptedLayoutIdentity;
    const beginsEstablishment = beginsGroupEstablishmentAt(outcome.nextState);
    // The state machine's own idempotent cell (product decision 28): the
    // epoch is preserved and the electorate fencing the running series must
    // not move either. The write still bumps the snapshot version and drives
    // the follow-up replan — that repair is the point of a repeated `plan`.
    const idempotentReplan = outcome.idempotentReplan;
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
            : command.operation === 'activateGroup'
            ? 0
            : stored.formationAttemptCount,
        acceptedLayoutIdentity,
        lastFormationOutcome: computeRecordedOutcome(command, stored, facts),
        formationElectorate: idempotentReplan ? stored.formationElectorate : formationElectorate,
        snapshotVersion: stored.snapshotVersion + 1,
        updated: auditStamp(command, facts, command.input.actorPrincipalId ?? undefined)
    };
}

/**
 * `reset` retires both layout slots in its own transaction (product decision
 * 36). The stored row keeps every field it had — the fingerprint stays valid
 * for tracing — and only its state changes, so nothing that reads the row for
 * evidence loses it. A slot holding no row has nothing to retire.
 */
function computeLayoutTombstones(
    command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>,
    read: GroupMutationRead
): GroupLayoutTombstones | null {
    if (command.operation !== 'resetGroupFormation') {
        return null;
    }
    return {
        planned: toLayoutTombstone(read.plannedLayoutRow),
        accepted: toLayoutTombstone(read.acceptedLayoutRow)
    };
}

function toLayoutTombstone(row: GroupPlannedLayoutRow | null): GroupPlannedLayoutRow | null {
    if (row === null) {
        return null;
    }
    // A removed row may hold no edge: the persisted decoder rejects one that
    // does, so carrying the graph forward would abort the write transaction.
    // `removedTopologyResult` keeps the sessions and empties their hops, and a
    // tombstone follows it.
    return {
        snapshot: {
            ...row.snapshot,
            state: 'removed',
            nextHopsBySessionId: Object.fromEntries(
                row.snapshot.activeSessionIds.map((sessionId) => [sessionId, []])
            )
        },
        revision: row.revision
    };
}

/**
 * The clean slate (product decisions 35/36). `reset` is the one transition
 * that clears rather than advances the series, so it gets its own shape
 * instead of a sixth arm in each of the ternaries above: the count, the
 * clock, the recorded outcome and the accepted identity all go, transport
 * halts, and the epoch still advances so every outstanding causal fence and
 * armed timer is invalidated. Membership, topology config and overrides are
 * deliberately untouched.
 */
function toClearedFormationSeries(
    { command, facts, stored, outcome, formationElectorate }: Readonly<{
        command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>;
        facts: GroupMutationFacts;
        stored: Group;
        outcome: Extract<ReturnType<typeof computeGroupLifecycleTransition>, { allowed: true; }>;
        formationElectorate: readonly string[];
    }>
): Group {
    return {
        ...stored,
        lifecycleState: outcome.nextState,
        formationEpoch: outcome.nextFormationEpoch,
        formationAttemptCount: 0,
        establishmentStartedAtEpochMs: null,
        lastFormationOutcome: null,
        acceptedLayoutIdentity: null,
        transportState: 'halted',
        formationElectorate,
        snapshotVersion: stored.snapshotVersion + 1,
        updated: auditStamp(command, facts, command.input.actorPrincipalId ?? undefined)
    };
}

/**
 * Activation's atomic promotion (product decisions 24/42): every accepted
 * activation promotes the stored planned layout it was fenced against. A
 * criterion activation's fence already rejected every non-promotable state,
 * so anything but apply/already-applied there is a programmer invariant; an
 * operator activation with no stored plan keeps today's behavior and commits
 * without accepted facts (dark landing — slice 5's connect makes plans
 * universal).
 */
function computeActivationPromotion(
    command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>,
    read: GroupMutationRead,
    stored: Group
): PlannedLayoutPromotion | null {
    if (command.operation !== 'activateGroup') {
        return null;
    }
    const promotion = computePlannedLayoutPromotion({
        expectedFormationEpoch: command.input.expectedFormationEpoch ?? null,
        expectedLayout: command.input.expectedLayout ?? null,
        currentFormationEpoch: stored.formationEpoch,
        planned: read.plannedLayoutRow,
        acceptedIdentity: stored.acceptedLayoutIdentity,
        acceptedRow: read.acceptedLayoutRow
    });
    if (
        command.input.expectedLayout !== null &&
        promotion.outcome !== 'apply' &&
        promotion.outcome !== 'already-applied'
    ) {
        throw new TypeError(
            `Criterion activation fence passed but promotion computed ${promotion.outcome}`
        );
    }
    return promotion;
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
    assertAllowed(
        canCommandGroupLifecycleTransition({
            ...toGroupAuthorityPolicyInput({ command, read, facts, policy }),
            transition
        })
    );
}
