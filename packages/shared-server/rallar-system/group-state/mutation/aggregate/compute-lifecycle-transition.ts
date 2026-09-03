import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    computeGroupLifecycleTransition,
    denyExhaustedFormationSeries,
    isFormationAttemptBudgetExhausted,
    resolveFormationFailureLanding,
    type GroupLifecycleTransition,
    type GroupLifecycleTransitionOutcome
} from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import { beginsGroupEstablishmentAt } from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { computeGroupConnectTrigger } from './compute-group-connect-trigger.ts';

import { computeFormationTimerEntries } from '../../formation-timer-outbox-entry.ts';
import { canCommandGroupLifecycleTransition, canMutateActiveGroup } from '../../policy/group-lifecycle-policy.ts';
import {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead,
    type GroupLifecycleTransitionOperation
} from '../group-mutation-contracts.ts';
import {
    auditStamp,
    computeGroupMutationWriteResult,
    rejected,
    rejectedByGroupPolicy
} from '../group-mutation-result.ts';
import { computeLifecycleFenceRejection } from './compute-lifecycle-fence-rejection.ts';
import {
    computePlannedLayoutPromotion,
    type GroupAcceptedLayoutRow,
    type GroupPlannedLayoutRow,
    type PlannedLayoutPromotion
} from './compute-planned-layout-promotion.ts';
import { toGroupAuthorityPolicyInput } from './group-aggregate-mutation-policy.ts';
import { resolveGroupAuthorityPolicy, toCorruptPolicyRejection } from './resolve-group-authority-policy.ts';

const LIFECYCLE_TRANSITION_BY_OPERATION = {
    planGroupLayout: 'plan',
    connectGroup: 'connect',
    startGroupFormation: 'start',
    resetGroupFormation: 'reset',
    activateGroup: 'activate',
    reconfigureGroup: 'reconfigure',
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
    const stored = read.group;
    if (stored === null) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Group not found: ${command.aggregateRef.groupId}`
        });
    }
    const active = canMutateActiveGroup({ group: stored.value, nowEpochMs: facts.nowEpochMs });
    if (!active.allowed) {
        return rejectedByGroupPolicy({ command, read, facts, denial: active });
    }
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
    const authorityRejection = computeLifecycleAuthorityRejection({ command, read, facts, policy, transition });
    if (authorityRejection !== null) {
        return authorityRejection;
    }
    const fenceRejection = computeLifecycleFenceRejection({ command, read, facts, stored: stored.value });
    if (fenceRejection !== null) {
        return fenceRejection;
    }
    return computeAuthorizedLifecycleTransition({
        command,
        read,
        facts,
        stored: stored.value,
        policy,
        transition,
        formationElectorate: read.activeMemberPrincipalIds
    });
}

interface AuthorizedLifecycleTransitionInput extends LifecycleTransitionDecisionInput {
    readonly stored: Group;
    readonly policy: GroupLifecyclePolicy;
    readonly transition: GroupLifecycleTransition;
    readonly formationElectorate: readonly string[];
}

/** Authority and fences are settled; decide the transition, promotion and resulting state. */
function computeAuthorizedLifecycleTransition(
    { command, read, facts, stored, policy, transition, formationElectorate }: AuthorizedLifecycleTransitionInput
): GroupMutationComputed {
    const outcome = computeAllowedLifecycleTransition(transition, stored, policy);
    if (!outcome.allowed) {
        return rejectedByGroupPolicy({ command, read, facts, denial: outcome });
    }
    const promotion = computeActivationPromotion(command, read, stored);
    if (promotion !== null && promotion.outcome !== 'apply' && promotion.outcome !== 'already-applied') {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Activation requires canonical planned layout promotion: ${promotion.outcome}`
        });
    }
    const reconfigureLanding = command.operation === 'reconfigureGroup'
        ? command.input.landing ?? policy.topology.reconfigureLanding
        : null;
    const next = command.operation === 'reconfigureGroup' &&
            reconfigureLanding === 'apply'
        ? computeApplyReconfigureLandingGroup(command, facts, stored)
        : computeNextLifecycleGroup({
            command,
            facts,
            stored,
            outcome,
            formationElectorate,
            promotion
        });
    return computeLifecycleTransitionWrite({ command, read, facts, next, policy, promotion });
}

/**
 * The state machine, the preconditions the stage does not carry, and where a
 * failure lands. All three are decided here rather than inside the initiator
 * policy, because internal authority skips that policy and the attempt budget
 * still binds it (product decision 37).
 */
function computeAllowedLifecycleTransition(
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
    const exhausted = denyExhaustedFormationSeries({
        transition,
        activation: policy.activation,
        formationAttemptCount: stored.formationAttemptCount
    });
    if (exhausted !== undefined) {
        return exhausted;
    }
    if (transition !== 'fail-formation') {
        return outcome;
    }
    // Exhaustion's `dormant` landing over the table's unexhausted one
    // (product decisions 35 and 37). The budget is asked about the attempt
    // this failure is about to record, so a series whose last attempt fails
    // parks instead of returning to a stage that would re-open a closed lobby
    // (product decision 38) and re-arm automation.
    const landing = resolveFormationFailureLanding({
        lifecycleState: stored.lifecycleState,
        attemptBudgetExhausted: isFormationAttemptBudgetExhausted({
            activation: policy.activation,
            formationAttemptCount: stored.formationAttemptCount + 1
        })
    });
    return landing === undefined ? outcome : { ...outcome, nextState: landing };
}

function computeNextLifecycleGroup(
    { command, facts, stored, outcome, formationElectorate, promotion }: Readonly<{
        command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>;
        facts: GroupMutationFacts;
        stored: Group;
        outcome: Extract<GroupLifecycleTransitionOutcome, { allowed: true; }>;
        formationElectorate: readonly string[];
        promotion: PlannedLayoutPromotion | null;
    }>
): Group {
    if (command.operation === 'resetGroupFormation') {
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

function toLayoutTombstone(row: GroupPlannedLayoutRow | null): GroupPlannedLayoutRow | null;
function toLayoutTombstone(row: GroupAcceptedLayoutRow | null): GroupAcceptedLayoutRow | null;
function toLayoutTombstone(
    row: GroupPlannedLayoutRow | GroupAcceptedLayoutRow | null
): GroupPlannedLayoutRow | GroupAcceptedLayoutRow | null {
    return row === null
        ? null
        : {
            ...row,
            snapshot: toRemovedLayoutSnapshot(row.snapshot)
        };
}

function toRemovedLayoutSnapshot(snapshot: RallarOverlayTopologySnapshot): RallarOverlayTopologySnapshot {
    return {
        ...snapshot,
        state: 'removed',
        nextHopsBySessionId: Object.fromEntries(
            Object.keys(snapshot.nextHopsBySessionId).map((sessionId) => [sessionId, []])
        )
    };
}

/**
 * Apply landing keeps the accepted layout live while the commanded topology
 * work produces and promotes its successor. The state-machine call above
 * still owns legality; this branch owns only the policy's no-transition
 * landing, so it cannot advance the formation fence or electorate.
 */
function computeApplyReconfigureLandingGroup(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    stored: Group
): Group {
    return {
        ...stored,
        snapshotVersion: stored.snapshotVersion + 1,
        updated: auditStamp(command, facts, command.input.actorPrincipalId ?? undefined)
    };
}

/**
 * Activation's atomic promotion (product decisions 24/42): every accepted
 * activation promotes the stored planned layout it was fenced against. A
 * missing or tombstoned plan rejects both principal and criterion activation.
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
function computeLifecycleAuthorityRejection(
    { command, read, facts, policy, transition }:
        & LifecycleTransitionDecisionInput
        & Readonly<{
            policy: GroupLifecyclePolicy;
            transition: GroupLifecycleTransition;
        }>
): GroupMutationComputed | null {
    if (facts.internalAuthority === 'formation-criterion' || facts.internalAuthority === 'formation-automation') {
        return null;
    }
    if (command.operation === 'failGroupFormation') {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: 'Formation failure is criterion-commanded only'
        });
    }
    const authority = canCommandGroupLifecycleTransition({
        ...toGroupAuthorityPolicyInput({ command, read, facts, policy }),
        transition
    });
    return authority.allowed ? null : rejectedByGroupPolicy({ command, read, facts, denial: authority });
}

interface LifecycleTransitionWriteInput extends LifecycleTransitionDecisionInput {
    readonly next: Group;
    readonly policy: GroupLifecyclePolicy;
    readonly promotion: PlannedLayoutPromotion | null;
}

function computeLifecycleTransitionWrite(
    { command, read, facts, next, policy, promotion }: LifecycleTransitionWriteInput
): GroupMutationComputed {
    const previous = read.group!.value.lifecycleState;
    const connectTrigger = computeGroupConnectTrigger({ command, read, facts, next, policy, previous });
    return computeGroupMutationWriteResult({
        connectTriggerLatchEffect: connectTrigger.effect,
        acceptedLayoutPromotion: promotion?.outcome === 'apply' ? promotion : null,
        layoutTombstones: command.operation === 'resetGroupFormation'
            ? {
                planned: toLayoutTombstone(read.plannedLayoutRow),
                accepted: toLayoutTombstone(read.acceptedLayoutRow)
            }
            : null,
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
            expectedRevision: read.group!.entry.revision
        },
        members: [],
        initialPresenceSummary: null,
        presenceAdmission: null,
        eventType: 'group-updated',
        presenceSummaryWork: 'enqueue',
        extraOutboxEntries: [
            ...computeFormationTimerEntries({ command, previous, next, policy, facts }),
            ...connectTrigger.outboxEntries
        ]
    });
}
