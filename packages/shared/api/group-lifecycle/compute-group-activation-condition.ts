import type { GroupLifecycleState, GroupTopologyReplanningMode } from './group-lifecycle-policy.ts';
import type { GroupLayoutIdentity } from './group-layout-identity.ts';
import { resolveDialLayoutRoles } from './resolve-dial-layout-roles.ts';

/**
 * The dwell before a coverage band change is believed, and the width the exit
 * threshold sits below its entry threshold so a per-group rate patch cannot
 * invert the `active ↔ degraded` band. Server defaults settled here (product
 * decisions 7 and 41); they become policy knobs only when an application needs
 * them.
 */
export const GROUP_ACTIVATION_STATUS_DWELL_MS = 3_000;
export const GROUP_ACTIVATION_HYSTERESIS_WIDTH = 0.05;
export const GROUP_ACTIVATION_EVIDENCE_EXPIRY_MS = 30_000;
export const GROUP_MINIMUM_LAYOUT_AGE_MS = 1_000;
export const GROUP_RTC_SETUP_TIMEOUT_MS = 15_000;

/** The business plane resolved to one liveness fact (status plus expiry). */
export type GroupBusinessLiveness =
    | 'active'
    | 'archived'
    | 'deleted'
    | 'expired';

export type GroupActivationCondition =
    | 'failed'
    | 'inactive'
    | 'degraded'
    | 'active'
    | 'initialising';

export type GroupActivationRemediation =
    | 'none'
    | 'replan-queued'
    | 'awaiting-application';

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
 * `initialising`. A halted group keeps its coverage condition, because the
 * halt is intent and the condition is connectivity.
 */
export function computeGroupActivationCondition(
    input: ComputeGroupActivationConditionInput
): GroupActivationCondition {
    if (input.business !== 'active') {
        return 'inactive';
    }
    const belowFloorForDwell = input.coverage !== undefined &&
        input.coverage.coverageRate < input.coverage.minimumViableRate &&
        input.coverage.dwellSatisfied;
    if (input.attemptBudgetExhausted || belowFloorForDwell) {
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
    readonly replanning: GroupTopologyReplanningMode;
    readonly layoutStale: boolean;
    readonly replanQueued: boolean;
}

/**
 * The remediation axis: whose move it is, naming only work the server actually
 * performs (product decision 30). `awaiting-application` covers the two cases
 * where only an application command can act — a stale layout under `commanded`
 * replanning, and a `dormant` group with its attempt budget spent.
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
    if (input.layoutStale && input.replanning === 'commanded') {
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
    readonly acceptedFingerprint: string | undefined;
    readonly planningAuthorityFingerprint: string | undefined;
}

/**
 * The latched staleness obligation (product decision 11): the accepted
 * layout's stored topology-input fingerprint no longer matches the planning
 * authority's. With no accepted layout there is nothing to be stale.
 */
export function computeLayoutStale(input: ComputeLayoutStaleInput): boolean {
    if (input.acceptedFingerprint === undefined || input.planningAuthorityFingerprint === undefined) {
        return false;
    }
    return input.acceptedFingerprint !== input.planningAuthorityFingerprint;
}
