import {
    toGroupStateValidationIssue,
    validateNonEmptyString,
    validateNonNegativeSafeInteger,
    validateOneOf,
    validateRequiredKeys,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';
import type { GroupLifecycleTransitionOperation } from '../group-mutation-contracts.ts';
import { validateExpectedLayoutIdentity } from './validate-expected-layout-identity.ts';

interface ValidateLifecycleGroupMutationCommandInput {
    readonly operation: GroupLifecycleTransitionOperation | 'applyPlannedLayout';
    readonly input: Readonly<Record<string, unknown>>;
    readonly requiredInputKeys: readonly string[];
}

/** Lifecycle commands own mandatory causal fences and operation-specific criteria. */
export function validateLifecycleGroupMutationCommandInput({
    operation,
    input,
    requiredInputKeys
}: ValidateLifecycleGroupMutationCommandInput): readonly GroupStateValidationIssue[] {
    const issues = [...validateRequiredKeys(input, requiredInputKeys, `Group ${operation} input`)];
    if (operation === 'connectGroup' || operation === 'applyPlannedLayout') {
        return [
            ...issues,
            ...validateRequiredLayoutFence(input, operation),
            ...(operation === 'connectGroup' && input.connectTriggerGeneration !== null
                ? validateNonEmptyString(input.connectTriggerGeneration, 'Group connectGroup connectTriggerGeneration')
                : [])
        ];
    }
    if (operation === 'reconfigureGroup' && input.landing !== null) {
        issues.push(...validateOneOf(input.landing, ['apply', 'hold'], 'Group reconfigureGroup landing'));
    }
    if (operation === 'activateGroup') {
        if (input.observedRate !== null && !isUnitIntervalNumber(input.observedRate)) {
            issues.push(toGroupStateValidationIssue(
                'input.observedRate',
                'Group activateGroup observedRate must be null or within [0, 1]'
            ));
        }
        if (input.degraded !== null && typeof input.degraded !== 'boolean') {
            issues.push(
                toGroupStateValidationIssue('input.degraded', 'Group activateGroup degraded must be boolean or null')
            );
        }
    }
    if (operation === 'failGroupFormation' && !isUnitIntervalNumber(input.observedRate)) {
        issues.push(toGroupStateValidationIssue(
            'input.observedRate',
            'Group failGroupFormation observedRate must be within [0, 1]'
        ));
    }
    issues.push(...validateNullableFormationEpoch(input, operation));
    if (operation === 'activateGroup' || operation === 'failGroupFormation') {
        issues.push(...validateNullableExpectedLayout(input, operation));
    }
    return issues;
}

function validateRequiredLayoutFence(
    input: Readonly<Record<string, unknown>>,
    operation: string
): readonly GroupStateValidationIssue[] {
    return [
        ...validateNonNegativeSafeInteger(input.expectedFormationEpoch, `Group ${operation} expectedFormationEpoch`),
        ...(input.expectedLayout === null
            ? [toGroupStateValidationIssue(
                'input.expectedLayout',
                `Group ${operation} expectedLayout must not be null`
            )]
            : validateNullableExpectedLayout(input, operation))
    ];
}

function validateNullableFormationEpoch(
    input: Readonly<Record<string, unknown>>,
    operation: string
): readonly GroupStateValidationIssue[] {
    return input.expectedFormationEpoch === null
        ? []
        : validateNonNegativeSafeInteger(input.expectedFormationEpoch, `Group ${operation} expectedFormationEpoch`);
}

function validateNullableExpectedLayout(
    input: Readonly<Record<string, unknown>>,
    operation: string
): readonly GroupStateValidationIssue[] {
    return input.expectedLayout === null
        ? []
        : validateExpectedLayoutIdentity(input, `Group ${operation} expectedLayout`);
}

function isUnitIntervalNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

