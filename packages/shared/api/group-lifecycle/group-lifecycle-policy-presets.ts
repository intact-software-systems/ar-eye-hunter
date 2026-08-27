import type { GroupLifecyclePolicy, GroupLifecyclePolicyPresetName } from './group-lifecycle-policy.ts';

/**
 * The default is `optimistic`, which is the behaviour a group has when no
 * policy is supplied at all: formation collapses to zero length, admission
 * stays open, and application data flows. Every other preset is a departure
 * from it.
 */
export function createDefaultGroupLifecyclePolicy(): GroupLifecyclePolicy {
    return resolveGroupLifecyclePolicyPreset('optimistic');
}

export function resolveGroupLifecyclePolicyPreset(
    name: GroupLifecyclePolicyPresetName
): GroupLifecyclePolicy {
    switch (name) {
        case 'optimistic':
            return OPTIMISTIC_POLICY;
        case 'managed':
            return MANAGED_POLICY;
        case 'match':
            return MATCH_POLICY;
        case 'drop-in-social':
            return DROP_IN_SOCIAL_POLICY;
    }
}

const OPTIMISTIC_POLICY: GroupLifecyclePolicy = {
    formation: 'immediate',
    initiator: 'any-member',
    manager: {
        selection: 'none',
        assignedPrincipalIds: [],
        count: 1,
        succession: 'none'
    },
    establishment: {
        transports: 'rtc-and-ws',
        maxConcurrentEdgeSetups: 64,
        planTrigger: { kind: 'immediate' },
        connectTrigger: { kind: 'immediate' }
    },
    activation: {
        mode: 'manual',
        successRate: 0,
        minimumViableRate: 0,
        deadlineMs: 0,
        maxFormationAttempts: 1,
        strictConfirmation: false
    },
    admission: {
        mode: 'open',
        untilEpochMs: null,
        untilMemberCount: null
    },
    topology: {
        replanning: 'auto',
        reconfigureLanding: 'apply',
        debounceWindowMs: 500,
        maxReplanWaitMs: 5_000
    },
    data: { preActivationAppData: 'allowed' }
};

/**
 * The manager curates who is in and when the group starts, not the wiring
 * (product decision 6): the plan trigger is manual so nothing moves before the
 * manager's `plan`, and the connect trigger is immediate so that one command
 * starts the dialing, preserving today's single manager action.
 */
const MANAGED_POLICY: GroupLifecyclePolicy = {
    formation: 'phased',
    initiator: 'manager',
    manager: {
        selection: 'creator',
        assignedPrincipalIds: [],
        count: 1,
        succession: 'next-by-selection'
    },
    establishment: {
        transports: 'rtc-and-ws',
        maxConcurrentEdgeSetups: 32,
        planTrigger: { kind: 'manual' },
        connectTrigger: { kind: 'immediate' }
    },
    activation: {
        mode: 'threshold-or-deadline',
        successRate: 0.95,
        minimumViableRate: 0.5,
        deadlineMs: 30_000,
        maxFormationAttempts: 3,
        strictConfirmation: false
    },
    admission: {
        mode: 'manager-approval',
        untilEpochMs: null,
        untilMemberCount: null
    },
    topology: {
        replanning: 'debounced',
        reconfigureLanding: 'apply',
        debounceWindowMs: 500,
        maxReplanWaitMs: 5_000
    },
    data: { preActivationAppData: 'allowed' }
};

/**
 * The floor equals the success rate, which is how this preset asks for
 * all-or-nothing: a session that is not fully connected does not start rather
 * than starting degraded. `strictConfirmation` stays false because the per-edge
 * confirmation ledger is not implemented; setting it true is rejected. Every
 * boundary is application-commanded: manual triggers, `commanded` replanning
 * and a `hold` landing.
 */
const MATCH_POLICY: GroupLifecyclePolicy = {
    formation: 'phased',
    initiator: 'manager',
    manager: {
        // elected-by-rank has no rank source in v1 (plan decision 4.2); the
        // deterministic election gives the preset a working manager until one
        // lands.
        selection: 'elected-random-deterministic',
        assignedPrincipalIds: [],
        count: 1,
        succession: 'next-by-selection'
    },
    establishment: {
        transports: 'rtc-preferred',
        maxConcurrentEdgeSetups: 16,
        planTrigger: { kind: 'manual' },
        connectTrigger: { kind: 'manual' }
    },
    activation: {
        mode: 'threshold-or-deadline',
        successRate: 1,
        minimumViableRate: 1,
        deadlineMs: 20_000,
        maxFormationAttempts: 2,
        strictConfirmation: false
    },
    admission: {
        mode: 'closed',
        untilEpochMs: null,
        untilMemberCount: null
    },
    topology: {
        replanning: 'commanded',
        reconfigureLanding: 'hold',
        debounceWindowMs: 500,
        maxReplanWaitMs: 5_000
    },
    data: { preActivationAppData: 'blocked-until-active' }
};

const DROP_IN_SOCIAL_POLICY: GroupLifecyclePolicy = {
    formation: 'immediate',
    initiator: 'server-auto',
    manager: {
        selection: 'none',
        assignedPrincipalIds: [],
        count: 1,
        succession: 'none'
    },
    establishment: {
        transports: 'rtc-and-ws',
        maxConcurrentEdgeSetups: 64,
        planTrigger: { kind: 'immediate' },
        connectTrigger: { kind: 'immediate' }
    },
    activation: {
        mode: 'threshold',
        successRate: 0.8,
        minimumViableRate: 0.25,
        deadlineMs: 0,
        maxFormationAttempts: 5,
        strictConfirmation: false
    },
    admission: {
        mode: 'open',
        untilEpochMs: null,
        untilMemberCount: 50
    },
    topology: {
        replanning: 'debounced',
        reconfigureLanding: 'apply',
        debounceWindowMs: 500,
        maxReplanWaitMs: 5_000
    },
    data: { preActivationAppData: 'allowed' }
};
