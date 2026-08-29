import {
    assertRequiredKeys,
    requireNonNegativeSafeInteger,
    requireOneOf
} from '../../group-state-validation-primitives.ts';
import type { GroupLifecycleTransitionOperation } from '../group-mutation-contracts.ts';
import { validateExpectedLayoutIdentity } from './validate-expected-layout-identity.ts';

type LifecycleCommandOperation = GroupLifecycleTransitionOperation | 'applyPlannedLayout';
type LifecycleInputRecord = Readonly<Record<string, unknown>>;

interface ValidateLifecycleGroupMutationCommandInput {
    readonly operation: LifecycleCommandOperation;
    readonly input: LifecycleInputRecord;
    readonly requiredInputKeys: readonly string[];
}

/**
 * Lifecycle commands share command-level fence validation but differ from
 * ordinary aggregate mutations in which fence is mandatory and whether it
 * must name a layout. Keeping that decision here keeps the generic command
 * validator focused on envelope, ownership, and exact-key checks.
 */
export function validateLifecycleGroupMutationCommandInput({
    operation,
    input,
    requiredInputKeys
}: ValidateLifecycleGroupMutationCommandInput): void {
    // A wire-decoded criterion command missing its fence keys is malformed
    // here, never a lying stale-epoch rejection deep in compute.
    assertRequiredKeys(input, requiredInputKeys, `Group ${operation} input`);
    if (operation === 'connectGroup' || operation === 'applyPlannedLayout') {
        validateRequiredLayoutFence(input, operation);
        return;
    }
    if (operation === 'reconfigureGroup') {
        validateNullableFormationEpoch(input, operation);
        if (input.landing !== null) {
            requireOneOf(input.landing, ['apply', 'hold'], 'Group reconfigureGroup landing');
        }
        return;
    }
    if (operation === 'activateGroup') {
        if (input.observedRate !== null && !isUnitIntervalNumber(input.observedRate)) {
            throw new TypeError('Group activateGroup observedRate must be null or within [0, 1]');
        }
        if (input.degraded !== null && typeof input.degraded !== 'boolean') {
            throw new TypeError('Group activateGroup degraded must be boolean or null');
        }
        validateNullableFormationEpoch(input, operation);
        validateNullableExpectedLayout(input, operation);
        return;
    }
    if (operation === 'failGroupFormation') {
        if (!isUnitIntervalNumber(input.observedRate)) {
            throw new TypeError('Group failGroupFormation observedRate must be within [0, 1]');
        }
        validateNullableFormationEpoch(input, operation);
        validateNullableExpectedLayout(input, operation);
        return;
    }
    validateNullableFormationEpoch(input, operation);
}

function validateRequiredLayoutFence(input: LifecycleInputRecord, operation: string): void {
    // The fences are non-null on these operations: null here is as malformed
    // as an absent key.
    requireNonNegativeSafeInteger(
        input.expectedFormationEpoch,
        `Group ${operation} expectedFormationEpoch`
    );
    if (input.expectedLayout === null) {
        throw new TypeError(`Group ${operation} expectedLayout must not be null`);
    }
    validateNullableExpectedLayout(input, operation);
}

function validateNullableFormationEpoch(input: LifecycleInputRecord, operation: string): void {
    if (input.expectedFormationEpoch !== null) {
        requireNonNegativeSafeInteger(
            input.expectedFormationEpoch,
            `Group ${operation} expectedFormationEpoch`
        );
    }
}

function validateNullableExpectedLayout(input: LifecycleInputRecord, operation: string): void {
    if (input.expectedLayout === null) {
        return;
    }
    validateExpectedLayoutIdentity(input, `Group ${operation} expectedLayout`);
}

function isUnitIntervalNumber(value: LifecycleInputRecord[string]): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
