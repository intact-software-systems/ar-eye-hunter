import type { Group } from '../../group-types.ts';
import { isSameGroupLayoutIdentity, type GroupLayoutIdentity } from '../group-layout-identity.ts';
import type { GroupLifecycleState, GroupTopologyReplanningMode } from '../group-lifecycle-policy.ts';
import { resolveDialLayoutRoles } from '../resolve-dial-layout-roles.ts';

/**
 * Server defaults settled once so no later slice invents values under
 * pressure (product decisions 7 and 41). Nothing in this file applies them:
 * the presence-summary worker floors a queued replan by the minimum layout
 * age, and the status writer slice owns the dwell, the hysteresis band (exit
 * sitting one width below entry) and evidence expiry.
 */
export const GROUP_ACTIVATION_STATUS_DWELL_MS = 3_000;
export const GROUP_ACTIVATION_HYSTERESIS_WIDTH = 0.05;
export const GROUP_ACTIVATION_EVIDENCE_EXPIRY_MS = 30_000;
export const GROUP_MINIMUM_LAYOUT_AGE_MS = 1_000;

/** The business plane resolved to one liveness fact (status plus expiry). */
export type GroupBusinessLiveness =
    | 'active'
    | 'archived'
    | 'deleted'
    | 'expired';

/**
 * The business plane resolved from the stored group: `requireActiveGroup`
 * answers the same question as a policy denial, which a read surface cannot
 * use, so the value form lives here beside the axis it feeds. Expiry is a
 * clock fact, so it is asked at the reader's instant, not stored. The two
 * still carry the rule separately: the predicate skips expiry entirely when
 * its caller passes no instant, and giving the value form that mode would
 * widen a shared contract for one caller's option.
 */
export function resolveGroupBusinessLiveness(
    group: Pick<Group, 'status' | 'expiresAtEpochMs'>,
    nowEpochMs: number
): GroupBusinessLiveness {
    if (group.status === 'archived' || group.status === 'deleted') {
        return group.status;
    }
    return group.expiresAtEpochMs !== null && group.expiresAtEpochMs <= nowEpochMs ? 'expired' : 'active';
}

export type GroupActivationCondition =
    | 'failed'
    | 'inactive'
    | 'degraded'
    | 'active'
    | 'initialising';

/** The runtime registry the validators check against. */
export const GROUP_ACTIVATION_CONDITIONS = [
    'failed',
    'inactive',
    'degraded',
    'active',
    'initialising'
] as const satisfies readonly GroupActivationCondition[];

export type GroupActivationRemediation =
    | 'none'
    | 'replan-queued'
    | 'awaiting-application';

/** The runtime registry the validators check against. */
export const GROUP_ACTIVATION_REMEDIATIONS = [
    'none',
    'replan-queued',
    'awaiting-application'
] as const satisfies readonly GroupActivationRemediation[];

export interface GroupCoverageObservation {
    readonly coverageRate: number;
    readonly successRate: number;
    readonly minimumViableRate: number;
    readonly dwellSatisfied: boolean;
}

export interface ComputeGroupActivationConditionInput {
    readonly business: GroupBusinessLiveness;
    readonly lifecycleState: GroupLifecycleState;
    readonly attemptBudgetExhausted: boolean;
    /** `undefined` while no layout is carrying traffic or being dialed. */
    readonly coverage: GroupCoverageObservation | undefined;
}

/**
 * The condition axis: coverage of the layout carrying traffic, and nothing
 * else (product decision 30). Total over the business plane (product decision
 * 41): an archived, deleted or expired group reads `inactive` — its routing
 * plane is frozen and no coverage claim is honest. Precedence follows the
 * product table: `failed`, then `inactive`, then the dwell-held bands, then
 * `initialising`. Exhaustion reads `failed` only in `dormant`, where the
 * spent series parked the group — a dialing group still on its final attempt
 * is judged by its coverage. A halted group keeps its coverage condition,
 * because the halt is intent and the condition is connectivity.
 */
export function computeGroupActivationCondition(
    input: ComputeGroupActivationConditionInput
): GroupActivationCondition {
    if (input.business !== 'active') {
        return 'inactive';
    }
    const exhaustedInDormant = input.attemptBudgetExhausted && input.lifecycleState === 'dormant';
    const belowFloorForDwell = input.coverage !== undefined &&
        input.coverage.coverageRate < input.coverage.minimumViableRate &&
        input.coverage.dwellSatisfied;
    if (exhaustedInDormant || belowFloorForDwell) {
        return 'failed';
    }
    if (input.coverage === undefined || resolveDialLayoutRoles(input.lifecycleState) === 'none') {
        return 'inactive';
    }
    if (input.coverage.coverageRate >= input.coverage.successRate) {
        return 'active';
    }
    if (input.coverage.coverageRate >= input.coverage.minimumViableRate && input.coverage.dwellSatisfied) {
        return 'degraded';
    }
    return 'initialising';
}

export interface ResolveGroupActivationRemediationInput {
    readonly business: GroupBusinessLiveness;
    readonly lifecycleState: GroupLifecycleState;
    readonly attemptBudgetExhausted: boolean;
    /**
     * The replanning mode as read: an unreadable stored policy is its own
     * input, because it is also what stops the automation from replanning.
     */
    readonly replanning: GroupTopologyReplanningMode | 'corrupt';
    readonly layoutStale: boolean;
    readonly replanQueued: boolean;
}

/**
 * The remediation axis: whose move it is, naming only work the server actually
 * performs (product decision 30). `awaiting-application` covers the cases where
 * only an application command can act — a stale layout the server will not
 * replan by itself, under `commanded` or under a policy it cannot read, and a
 * `dormant` group with its attempt budget spent.
 */
export function resolveGroupActivationRemediation(
    input: ResolveGroupActivationRemediationInput
): GroupActivationRemediation {
    if (input.business !== 'active') {
        return 'none';
    }
    if (input.lifecycleState === 'dormant' && input.attemptBudgetExhausted) {
        return 'awaiting-application';
    }
    if (input.replanQueued) {
        return 'replan-queued';
    }
    // A corrupt policy replans no more than `commanded` does, so a stale
    // layout under one is equally the application's move.
    if (input.layoutStale && input.replanning !== 'auto' && input.replanning !== 'debounced') {
        return 'awaiting-application';
    }
    return 'none';
}

export interface ResolveCoverageBasisLayoutIdentityInput {
    readonly lifecycleState: GroupLifecycleState;
    readonly accepted: GroupLayoutIdentity | undefined;
    readonly plannedCandidate: GroupLayoutIdentity | undefined;
}

/**
 * The exact layout every status causal key is scoped to (product decisions 13,
 * 30 and 33): accepted whenever an accepted layout exists; before first
 * activation it is the frozen planned candidate being dialed during initial
 * `connecting`; stages with neither have no basis and no causal series.
 * `reconnecting` always has an accepted layout, so its no-accepted row is the
 * impossible state and claims nothing.
 */
const BASIS_WITHOUT_ACCEPTED: Readonly<Record<GroupLifecycleState, 'planned-candidate' | 'none'>> = {
    dormant: 'none',
    forming: 'none',
    planned: 'none',
    connecting: 'planned-candidate',
    active: 'none',
    reconfiguring: 'none',
    reconnecting: 'none'
};

export function resolveCoverageBasisLayoutIdentity(
    input: ResolveCoverageBasisLayoutIdentityInput
): GroupLayoutIdentity | undefined {
    if (input.accepted !== undefined) {
        return input.accepted;
    }
    return BASIS_WITHOUT_ACCEPTED[input.lifecycleState] === 'planned-candidate'
        ? input.plannedCandidate
        : undefined;
}

export interface ComputeLayoutStaleInput {
    readonly acceptedIdentity: GroupLayoutIdentity | null;
    readonly plannedIdentity: GroupLayoutIdentity | null;
    /** The planned slot's stored topology-input fingerprint; null when no cycle stored one. */
    readonly plannedFingerprint: string | null;
    readonly planningAuthorityFingerprint: string;
}

/**
 * The latched staleness obligation (product decision 11, implementation
 * decision I27): the accepted layout is always a promoted planned layout, so
 * its topology inputs are the planned slot's whenever the two identities
 * agree; a planned layout the group does not yet run on means the authority
 * has already moved past the accepted one. With no accepted layout there is
 * nothing to be stale.
 */
export function computeLayoutStale(input: ComputeLayoutStaleInput): boolean {
    if (input.acceptedIdentity === null) {
        return false;
    }
    if (input.plannedIdentity === null || !isSameGroupLayoutIdentity(input.acceptedIdentity, input.plannedIdentity)) {
        return true;
    }
    return input.plannedFingerprint !== input.planningAuthorityFingerprint;
}
