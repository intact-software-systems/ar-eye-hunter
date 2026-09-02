import type { PrincipalId } from '../group-types.ts';

/**
 * The stage registry. Every stage-keyed decision is a total function over this
 * array (product decision 41), and the runtime enum validators pass it
 * directly, so adding a stage is a compile error at every decision site and
 * never a silent fallthrough. `dormant`, `planned` and `reconnecting` are
 * unreachable until their producing transitions land; every current consumer
 * holds an explicit row for them.
 */
export const GROUP_LIFECYCLE_STATES = [
    'dormant',
    'forming',
    'planned',
    'connecting',
    'active',
    'reconfiguring',
    'reconnecting'
] as const;

export type GroupLifecycleState = typeof GROUP_LIFECYCLE_STATES[number];

/**
 * Halting is a transport fact, not a stage (product decision 25): `pause` sets
 * `halted`, `resume` sets `flowing`, and neither touches the routing plane.
 */
export type GroupTransportState =
    | 'flowing'
    | 'halted';

/** The runtime registry the validators check against. */
export const GROUP_TRANSPORT_STATES = [
    'flowing',
    'halted'
] as const satisfies readonly GroupTransportState[];

export type GroupFormationMode =
    | 'phased'
    | 'immediate';

export type GroupManagerSelection =
    | 'none'
    | 'creator'
    | 'assigned'
    | 'elected-by-rank'
    | 'elected-random-deterministic';

export type GroupManagerSuccession =
    | 'next-by-selection'
    | 'none';

export type GroupEstablishmentTransports =
    | 'rtc-and-ws'
    | 'ws-only'
    | 'rtc-preferred';

/** The runtime registry the validators check against. */
export const GROUP_ESTABLISHMENT_TRANSPORTS = [
    'rtc-and-ws',
    'ws-only',
    'rtc-preferred'
] as const satisfies readonly GroupEstablishmentTransports[];

/**
 * The member tier of the policy (product decision 26), copied onto the group
 * at creation so every member's browser bounds its own RTC setups from the
 * snapshot it already holds (implementation decision I13). Declared at group
 * scope, executed per member; write-once like the policy it comes from.
 */
export type GroupMemberPolicy = Readonly<{
    maxConcurrentEdgeSetups: number;
    transports: GroupEstablishmentTransports;
}>;

export const GROUP_MEMBER_POLICY_KEYS = [
    'maxConcurrentEdgeSetups',
    'transports'
] as const satisfies readonly (keyof GroupMemberPolicy)[];

/**
 * Who may issue the eight application-facing group-authority commands. One
 * policy governs all of them (product decision 12), and the field lives on the
 * group-authority tier, not under establishment (product decision 26).
 * `server-auto` denies every principal and leaves the stages to policy
 * automation.
 */
export type GroupLifecycleInitiator =
    | 'manager'
    | 'any-member'
    | 'server-auto';

/**
 * Replanning after a layout exists (product decision 2): `auto` replans on the
 * first opportunity after a change, `debounced` coalesces under the per-group
 * window with a bounded maximum wait (product decision 31), and `commanded`
 * queues nothing — the layout moves only on `reconfigure`.
 */
export type GroupTopologyReplanningMode =
    | 'auto'
    | 'debounced'
    | 'commanded';

/**
 * Whether the accepted layout follows a newly planned one with no lifecycle
 * transition (`apply`, product decision 27) or waits in `reconfiguring` for a
 * commanded `connect` (`hold`).
 */
export type GroupTopologyReconfigureLanding =
    | 'apply'
    | 'hold';

export type GroupTopologyPolicy = Readonly<{
    replanning: GroupTopologyReplanningMode;
    reconfigureLanding: GroupTopologyReconfigureLanding;
    debounceWindowMs: number;
    maxReplanWaitMs: number;
}>;

/**
 * One trigger vocabulary drives the automatic boundaries of `phased` groups
 * (product decision 8): `forming → planned` and `planned → connecting`.
 * `manual` means the boundary waits for an application command, mirroring
 * `GroupActivationMode`'s use of the word.
 */
export type GroupStageTrigger =
    | Readonly<{ kind: 'manual'; }>
    | Readonly<{ kind: 'immediate'; }>
    | Readonly<{ kind: 'after'; settleMs: number; }>
    | Readonly<{ kind: 'presence'; memberCount: number; fallbackMs: number; }>;

export type GroupActivationMode =
    | 'threshold'
    | 'deadline'
    | 'manual'
    | 'threshold-or-deadline';

export type GroupAdmissionMode =
    | 'open'
    | 'manager-approval'
    | 'closed';

export type GroupPreActivationAppData =
    | 'allowed'
    | 'blocked-until-active';

export type GroupManagerPolicy = Readonly<{
    selection: GroupManagerSelection;
    assignedPrincipalIds: readonly PrincipalId[];
    count: number;
    succession: GroupManagerSuccession;
}>;

export type GroupEstablishmentPolicy = Readonly<{
    transports: GroupEstablishmentTransports;
    maxConcurrentEdgeSetups: number;
    planTrigger: GroupStageTrigger;
    connectTrigger: GroupStageTrigger;
}>;

/**
 * Two rates rather than one: at or above `successRate` the group activates, at
 * or above `minimumViableRate` it activates degraded, and below the floor it
 * does not activate at all. A single rate cannot distinguish a group that is
 * usably connected from one that is not, so `minimumViableRate` equal to
 * `successRate` is how a caller asks for all-or-nothing.
 */
export type GroupActivationCriterion = Readonly<{
    mode: GroupActivationMode;
    successRate: number;
    minimumViableRate: number;
    deadlineMs: number;
    maxFormationAttempts: number;
    strictConfirmation: boolean;
}>;

/** `null` means the constraint does not apply, which composes with any mode. */
export type GroupAdmissionPolicy = Readonly<{
    mode: GroupAdmissionMode;
    untilEpochMs: number | null;
    untilMemberCount: number | null;
}>;

export type GroupDataPolicy = Readonly<{
    preActivationAppData: GroupPreActivationAppData;
}>;

/**
 * A recorded formation decision -- what the criterion concluded the last time
 * it evaluated, with the observed rate at that moment. Live readiness is
 * derived on read and never stored; this is the decision, not the observation.
 */
export type GroupFormationOutcome = Readonly<{
    outcome: 'activated' | 'activated-degraded' | 'below-floor';
    observedRate: number;
    atEpochMs: number;
    formationEpoch: number;
}>;

export type GroupLifecyclePolicy = Readonly<{
    formation: GroupFormationMode;
    initiator: GroupLifecycleInitiator;
    manager: GroupManagerPolicy;
    establishment: GroupEstablishmentPolicy;
    activation: GroupActivationCriterion;
    admission: GroupAdmissionPolicy;
    topology: GroupTopologyPolicy;
    data: GroupDataPolicy;
}>;

export const GROUP_LIFECYCLE_POLICY_PRESET_NAMES = [
    'optimistic',
    'managed',
    'match',
    'drop-in-social'
] as const;

export type GroupLifecyclePolicyPresetName = typeof GROUP_LIFECYCLE_POLICY_PRESET_NAMES[number];

/** Sparse external input. Absent fields take the preset or server default. */
export type GroupLifecyclePolicyInput = Readonly<{
    preset?: GroupLifecyclePolicyPresetName;
    formation?: GroupFormationMode;
    initiator?: GroupLifecycleInitiator;
    manager?: Partial<GroupManagerPolicy>;
    establishment?: Partial<GroupEstablishmentPolicy>;
    activation?: Partial<GroupActivationCriterion>;
    admission?: Partial<GroupAdmissionPolicy>;
    topology?: Partial<GroupTopologyPolicy>;
    data?: Partial<GroupDataPolicy>;
}>;

export const GROUP_LIFECYCLE_POLICY_ISSUE_CODES = [
    'manager-initiator-without-manager',
    'manager-approval-without-manager',
    'viable-rate-above-success-rate',
    'threshold-mode-requires-positive-rate',
    'deadline-mode-requires-positive-deadline',
    'assigned-selection-requires-principals',
    'manager-count-exceeds-assigned-principals',
    'strict-confirmation-unsupported',
    'server-auto-requires-automatic-trigger',
    'server-auto-requires-automatic-activation',
    'server-auto-cannot-command-replanning',
    'replan-window-exceeds-maximum-wait'
] as const;

export type GroupLifecyclePolicyIssueCode = typeof GROUP_LIFECYCLE_POLICY_ISSUE_CODES[number];

export type GroupLifecyclePolicyIssue = Readonly<{
    code: GroupLifecyclePolicyIssueCode;
    field: string;
    message: string;
}>;
