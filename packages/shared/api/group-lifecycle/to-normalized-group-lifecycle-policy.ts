import type {
    GroupActivationCriterion,
    GroupAdmissionPolicy,
    GroupDataPolicy,
    GroupEstablishmentPolicy,
    GroupLifecyclePolicy,
    GroupLifecyclePolicyInput,
    GroupManagerPolicy,
} from './group-lifecycle-policy.ts';
import {
    createDefaultGroupLifecyclePolicy,
    resolveGroupLifecyclePolicyPreset,
} from './group-lifecycle-policy-presets.ts';

export const MAX_GROUP_FORMATION_DEADLINE_MS = 600_000;
export const MAX_GROUP_MANAGERS = 16;
export const MAX_GROUP_CONCURRENT_EDGE_SETUPS = 256;
export const MAX_GROUP_FORMATION_ATTEMPTS = 16;
export const MAX_GROUP_ADMISSION_MEMBER_COUNT = 100_000;

/**
 * Sparse client input to a complete policy: the preset (or the optimistic
 * default) supplies every field the caller omitted, and every numeric field is
 * clamped to a server bound. Clamping is deliberately silent and total, so a
 * caller cannot produce an out-of-range policy; contradictions between fields
 * are a separate concern and belong to validateGroupLifecyclePolicy.
 */
export function toNormalizedGroupLifecyclePolicy(
    input: GroupLifecyclePolicyInput = {},
): GroupLifecyclePolicy {
    const base = input.preset === undefined
        ? createDefaultGroupLifecyclePolicy()
        : resolveGroupLifecyclePolicyPreset(input.preset);

    return {
        formation: input.formation ?? base.formation,
        manager: toManagerPolicy(base.manager, input.manager),
        establishment: toEstablishmentPolicy(base.establishment, input.establishment),
        activation: toActivationCriterion(base.activation, input.activation),
        admission: toAdmissionPolicy(base.admission, input.admission),
        data: toDataPolicy(base.data, input.data),
    };
}

function toManagerPolicy(
    base: GroupManagerPolicy,
    input: Partial<GroupManagerPolicy> | undefined,
): GroupManagerPolicy {
    return {
        selection: input?.selection ?? base.selection,
        assignedPrincipalIds: input?.assignedPrincipalIds ?? base.assignedPrincipalIds,
        count: toClampedInteger(input?.count ?? base.count, 1, MAX_GROUP_MANAGERS),
        succession: input?.succession ?? base.succession,
    };
}

function toEstablishmentPolicy(
    base: GroupEstablishmentPolicy,
    input: Partial<GroupEstablishmentPolicy> | undefined,
): GroupEstablishmentPolicy {
    return {
        transports: input?.transports ?? base.transports,
        initiator: input?.initiator ?? base.initiator,
        maxConcurrentEdgeSetups: toClampedInteger(
            input?.maxConcurrentEdgeSetups ?? base.maxConcurrentEdgeSetups,
            1,
            MAX_GROUP_CONCURRENT_EDGE_SETUPS,
        ),
    };
}

function toActivationCriterion(
    base: GroupActivationCriterion,
    input: Partial<GroupActivationCriterion> | undefined,
): GroupActivationCriterion {
    return {
        mode: input?.mode ?? base.mode,
        successRate: toClampedRate(input?.successRate ?? base.successRate),
        minimumViableRate: toClampedRate(input?.minimumViableRate ?? base.minimumViableRate),
        deadlineMs: toClampedInteger(
            input?.deadlineMs ?? base.deadlineMs,
            0,
            MAX_GROUP_FORMATION_DEADLINE_MS,
        ),
        maxFormationAttempts: toClampedInteger(
            input?.maxFormationAttempts ?? base.maxFormationAttempts,
            1,
            MAX_GROUP_FORMATION_ATTEMPTS,
        ),
        strictConfirmation: input?.strictConfirmation ?? base.strictConfirmation,
    };
}

function toAdmissionPolicy(
    base: GroupAdmissionPolicy,
    input: Partial<GroupAdmissionPolicy> | undefined,
): GroupAdmissionPolicy {
    const untilEpochMs = input?.untilEpochMs === undefined
        ? base.untilEpochMs
        : input.untilEpochMs;
    const untilMemberCount = input?.untilMemberCount === undefined
        ? base.untilMemberCount
        : input.untilMemberCount;

    return {
        mode: input?.mode ?? base.mode,
        untilEpochMs: untilEpochMs === null
            ? null
            : toClampedInteger(untilEpochMs, 0, Number.MAX_SAFE_INTEGER),
        untilMemberCount: untilMemberCount === null
            ? null
            : toClampedInteger(untilMemberCount, 1, MAX_GROUP_ADMISSION_MEMBER_COUNT),
    };
}

function toDataPolicy(
    base: GroupDataPolicy,
    input: Partial<GroupDataPolicy> | undefined,
): GroupDataPolicy {
    return {
        preActivationAppData: input?.preActivationAppData ?? base.preActivationAppData,
    };
}

function toClampedRate(value: number): number {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function toClampedInteger(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) {
        return minimum;
    }
    return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
