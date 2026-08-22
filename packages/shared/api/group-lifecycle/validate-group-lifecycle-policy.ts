import { Either } from '../../resilience/Either.ts';

import type { GroupLifecyclePolicy, GroupLifecyclePolicyIssue } from './group-lifecycle-policy.ts';

/**
 * Contradictions between fields, which clamping cannot catch: a clamp keeps one
 * value in range, this rejects combinations that are individually legal and
 * jointly unreachable. Returns every issue rather than the first, so a caller
 * fixes one policy document once.
 */
export function validateGroupLifecyclePolicy(
    policy: GroupLifecyclePolicy
): Either<readonly GroupLifecyclePolicyIssue[], GroupLifecyclePolicy> {
    const issues: GroupLifecyclePolicyIssue[] = [
        ...toManagerIssues(policy),
        ...toActivationIssues(policy)
    ];

    return issues.length === 0
        ? Either.ofRight(policy)
        : Either.ofLeft(issues);
}

function toManagerIssues(
    policy: GroupLifecyclePolicy
): readonly GroupLifecyclePolicyIssue[] {
    const issues: GroupLifecyclePolicyIssue[] = [];
    const { manager, establishment } = policy;

    // Nobody could ever start establishment, so the group would hold in FORMING
    // for its whole life.
    if (manager.selection === 'none' && establishment.initiator === 'manager') {
        issues.push({
            code: 'manager-initiator-without-manager',
            field: 'establishment.initiator',
            message: 'establishment.initiator is manager but manager.selection is none, ' +
                'so no principal can ever start establishment'
        });
    }

    if (manager.selection === 'assigned' && manager.assignedPrincipalIds.length === 0) {
        issues.push({
            code: 'assigned-selection-requires-principals',
            field: 'manager.assignedPrincipalIds',
            message: 'manager.selection is assigned but no principals were assigned'
        });
    }

    if (
        manager.selection === 'assigned' &&
        manager.assignedPrincipalIds.length > 0 &&
        manager.count > manager.assignedPrincipalIds.length
    ) {
        issues.push({
            code: 'manager-count-exceeds-assigned-principals',
            field: 'manager.count',
            message: 'manager.count exceeds the number of assigned principals'
        });
    }

    // Nobody could ever grant a parked join. Transient zero-manager states
    // stay legal (invite is the recovery channel); only the permanently
    // granterless combination is invalid (plan decision 5.3).
    if (policy.admission.mode === 'manager-approval' && manager.selection === 'none') {
        issues.push({
            code: 'manager-approval-without-manager',
            field: 'admission.mode',
            message: 'admission.mode is manager-approval but manager.selection is none, ' +
                'so no principal could ever grant a pending admission'
        });
    }

    return issues;
}

function toActivationIssues(
    policy: GroupLifecyclePolicy
): readonly GroupLifecyclePolicyIssue[] {
    const issues: GroupLifecyclePolicyIssue[] = [];
    const { activation } = policy;

    if (activation.minimumViableRate > activation.successRate) {
        issues.push({
            code: 'viable-rate-above-success-rate',
            field: 'activation.minimumViableRate',
            message: 'activation.minimumViableRate is above activation.successRate, ' +
                'which leaves no rate at which the group activates degraded'
        });
    }

    if (usesThreshold(activation.mode) && activation.successRate <= 0) {
        issues.push({
            code: 'threshold-mode-requires-positive-rate',
            field: 'activation.successRate',
            message: 'activation.mode requires a threshold but successRate is not positive'
        });
    }

    if (usesDeadline(activation.mode) && activation.deadlineMs <= 0) {
        issues.push({
            code: 'deadline-mode-requires-positive-deadline',
            field: 'activation.deadlineMs',
            message: 'activation.mode requires a deadline but deadlineMs is not positive'
        });
    }

    // The per-edge confirmation ledger this selects is not implemented. The
    // field exists so the intent can be expressed and answered, rather than
    // silently accepted and ignored.
    if (activation.strictConfirmation) {
        issues.push({
            code: 'strict-confirmation-unsupported',
            field: 'activation.strictConfirmation',
            message: 'activation.strictConfirmation is not supported in this release'
        });
    }

    return issues;
}

function usesThreshold(mode: GroupLifecyclePolicy['activation']['mode']): boolean {
    return mode === 'threshold' || mode === 'threshold-or-deadline';
}

function usesDeadline(mode: GroupLifecyclePolicy['activation']['mode']): boolean {
    return mode === 'deadline' || mode === 'threshold-or-deadline';
}
