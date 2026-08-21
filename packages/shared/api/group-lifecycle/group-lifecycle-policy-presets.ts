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
    manager: {
        selection: 'none',
        assignedPrincipalIds: [],
        count: 1,
        succession: 'none'
    },
    establishment: {
        transports: 'rtc-and-ws',
        initiator: 'any-member',
        maxConcurrentEdgeSetups: 64
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
    data: { preActivationAppData: 'allowed' }
};

const MANAGED_POLICY: GroupLifecyclePolicy = {
    formation: 'phased',
    manager: {
        selection: 'creator',
        assignedPrincipalIds: [],
        count: 1,
        succession: 'next-by-selection'
    },
    establishment: {
        transports: 'rtc-and-ws',
        initiator: 'manager',
        maxConcurrentEdgeSetups: 32
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
    data: { preActivationAppData: 'allowed' }
};

/**
 * The floor equals the success rate, which is how this preset asks for
 * all-or-nothing: a session that is not fully connected does not start rather
 * than starting degraded. `strictConfirmation` stays false because the per-edge
 * confirmation ledger is not implemented; setting it true is rejected.
 */
const MATCH_POLICY: GroupLifecyclePolicy = {
    formation: 'phased',
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
        initiator: 'manager',
        maxConcurrentEdgeSetups: 16
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
    data: { preActivationAppData: 'blocked-until-active' }
};

const DROP_IN_SOCIAL_POLICY: GroupLifecyclePolicy = {
    formation: 'immediate',
    manager: {
        selection: 'none',
        assignedPrincipalIds: [],
        count: 1,
        succession: 'none'
    },
    establishment: {
        transports: 'rtc-and-ws',
        initiator: 'server-auto',
        maxConcurrentEdgeSetups: 64
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
    data: { preActivationAppData: 'allowed' }
};
