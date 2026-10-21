import type { JsonWireObject } from '../../../protocol/json-wire-identity.ts';
import {
    assertRequiredKeys,
    requireNonNegativeSafeInteger,
    requireOneOf
} from '../../group-state-validation-primitives.ts';
import { requireUnitRate } from '../../require-unit-rate.ts';
import type { GroupLifecycleTransitionOperation } from '../group-mutation-contracts.ts';
import { assertExpectedLayoutIdentity } from './assert-expected-layout-identity.ts';

interface AssertLifecycleGroupMutationCommandInput {
    readonly operation: GroupLifecycleTransitionOperation | 'applyPlannedLayout';
    readonly input: JsonWireObject;
    readonly requiredInputKeys: readonly string[];
}

/**
 * Lifecycle commands share command-level fence validation but differ from
 * ordinary aggregate mutations in which fence is mandatory and whether it
 * must name a layout. Keeping that decision here keeps the generic command
 * validator focused on envelope, ownership, and exact-key checks.
 */
export function assertLifecycleGroupMutationCommandInput({
    operation,
    input,
    requiredInputKeys
}: AssertLifecycleGroupMutationCommandInput): void {
    // A wire-decoded criterion command missing its fence keys is malformed
    // here, never a lying stale-epoch rejection deep in compute.
    assertRequiredKeys(input, requiredInputKeys, `Group ${operation} input`);
    if (
        operation === 'connectGroup' && input.connectTriggerGeneration !== null &&
        (typeof input.connectTriggerGeneration !== 'string' || input.connectTriggerGeneration.length === 0)
    ) {
        throw new TypeError('Group connect trigger generation must be null or a non-empty string');
    }
    if (operation === 'connectGroup' || operation === 'applyPlannedLayout') {
        assertRequiredLayoutFence(input, operation);
        return;
    }
    if (operation === 'reconfigureGroup') {
        assertNullableFormationEpoch(input, operation);
        if (input.landing !== null) {
            requireOneOf(input.landing, ['apply', 'hold'], 'Group reconfigureGroup landing');
        }
        return;
    }
    if (operation === 'activateGroup') {
        assertActivateGroupInput(input);
        return;
    }
    if (operation === 'failGroupFormation') {
        requireUnitRate(input.observedRate, 'Group failGroupFormation observedRate');
        assertNullableFormationEpoch(input, operation);
        assertNullableExpectedLayout(input, operation);
        return;
    }
    assertNullableFormationEpoch(input, operation);
}

function assertActivateGroupInput(input: JsonWireObject): void {
    if (input.observedRate !== null) {
        requireUnitRate(input.observedRate, 'Group activateGroup observedRate');
    }
    if (input.degraded !== null && typeof input.degraded !== 'boolean') {
        throw new TypeError('Group activateGroup degraded must be boolean or null');
    }
    assertNullableFormationEpoch(input, 'activateGroup');
    assertNullableExpectedLayout(input, 'activateGroup');
}

function assertRequiredLayoutFence(input: JsonWireObject, operation: string): void {
    // The fences are non-null on these operations: null here is as malformed
    // as an absent key.
    requireNonNegativeSafeInteger(
        input.expectedFormationEpoch,
        `Group ${operation} expectedFormationEpoch`
    );
    if (input.expectedLayout === null) {
        throw new TypeError(`Group ${operation} expectedLayout must not be null`);
    }
    assertNullableExpectedLayout(input, operation);
}

function assertNullableFormationEpoch(input: JsonWireObject, operation: string): void {
    if (input.expectedFormationEpoch !== null) {
        requireNonNegativeSafeInteger(
            input.expectedFormationEpoch,
            `Group ${operation} expectedFormationEpoch`
        );
    }
}

function assertNullableExpectedLayout(input: JsonWireObject, operation: string): void {
    if (input.expectedLayout === null) {
        return;
    }
    assertExpectedLayoutIdentity(input, `Group ${operation} expectedLayout`);
}
