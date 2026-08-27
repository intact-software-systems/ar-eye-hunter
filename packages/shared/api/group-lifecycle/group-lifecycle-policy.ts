import type { PrincipalId } from '../group-types.ts';

export type GroupLifecycleState =
    | 'forming'
    | 'connecting'
    | 'active'
    | 'reconfiguring';

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

export type GroupEstablishmentInitiator =
    | 'manager'
    | 'any-member'
    | 'server-auto';

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
    initiator: GroupEstablishmentInitiator;
    maxConcurrentEdgeSetups: number;
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
    manager: GroupManagerPolicy;
    establishment: GroupEstablishmentPolicy;
    activation: GroupActivationCriterion;
    admission: GroupAdmissionPolicy;
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
    manager?: Partial<GroupManagerPolicy>;
    establishment?: Partial<GroupEstablishmentPolicy>;
    activation?: Partial<GroupActivationCriterion>;
    admission?: Partial<GroupAdmissionPolicy>;
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
    'strict-confirmation-unsupported'
] as const;

export type GroupLifecyclePolicyIssueCode = typeof GROUP_LIFECYCLE_POLICY_ISSUE_CODES[number];

export type GroupLifecyclePolicyIssue = Readonly<{
    code: GroupLifecyclePolicyIssueCode;
    field: string;
    message: string;
}>;
