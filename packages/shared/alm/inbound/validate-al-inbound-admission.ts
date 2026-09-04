import { Temporal } from '@js-temporal/polyfill';

import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type {
    ALInboundBufferedReleaseReadDto,
    ALInboundCommitBundle,
    ALInboundMessageReadDto
} from './al-inbound-admission-store.ts';
import {
    computeALInboundAdmission,
    computeALInboundBufferedRelease,
    type ALInboundComputationFacts
} from './compute-al-inbound-admission.ts';

export interface ALInboundAdmissionValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: TypeError;
}

export interface ValidateALInboundAdmissionInput {
    readonly read: ALInboundMessageReadDto;
    readonly canForward: boolean;
    readonly facts: ALInboundComputationFacts;
    readonly computed: ALInboundCommitBundle;
}

export interface ValidateALInboundBufferedReleaseInput {
    readonly read: ALInboundBufferedReleaseReadDto;
    readonly plan: ALMessageHandlingPlan;
    readonly facts: ALInboundComputationFacts;
    readonly computed: ALInboundCommitBundle;
}

interface ExactValueComparisonState {
    readonly comparedCandidates: WeakMap<object, WeakSet<object>>;
}

interface AppendExactArrayDifferencesInput<Value> {
    readonly issues: ALInboundAdmissionValidationIssue[];
    readonly path: string;
    readonly expected: readonly Value[];
    readonly candidate: readonly Value[];
}

interface AppendExactDifferenceInput<Value> {
    readonly issues: ALInboundAdmissionValidationIssue[];
    readonly path: string;
    readonly expected: Value;
    readonly candidate: Value;
}

interface AppendExactDataShapeDifferenceInput {
    readonly issues: ALInboundAdmissionValidationIssue[];
    readonly path: string;
    readonly expected: object;
    readonly candidate: object;
}

export function validateALInboundAdmission(
    input: ValidateALInboundAdmissionInput
): readonly ALInboundAdmissionValidationIssue[] {
    return validateALInboundComputedBundle(
        input.facts,
        input.computed,
        () => computeALInboundAdmission(input.read, input.canForward, input.facts)
    );
}

export function validateALInboundBufferedRelease(
    input: ValidateALInboundBufferedReleaseInput
): readonly ALInboundAdmissionValidationIssue[] {
    return validateALInboundComputedBundle(
        input.facts,
        input.computed,
        () => computeALInboundBufferedRelease(input.read, input.plan, input.facts)
    );
}

function validateALInboundComputedBundle(
    facts: ALInboundComputationFacts,
    computed: ALInboundCommitBundle,
    computeExpected: () => ALInboundCommitBundle
): readonly ALInboundAdmissionValidationIssue[] {
    const issues = validateALInboundComputationFacts(facts);
    let expected: ALInboundCommitBundle;
    try {
        expected = computeExpected();
    }
    catch (error) {
        issues.push(toALInboundAdmissionValidationIssue(
            'computed',
            `cannot be recomputed: ${error instanceof Error ? error.message : String(error)}`
        ));
        return issues;
    }

    if (
        !appendExactDataShapeDifference({
            issues,
            path: 'computed',
            expected,
            candidate: computed
        })
    ) {
        return issues;
    }

    appendExactDifference({
        issues,
        path: 'computed.senderId',
        expected: expected.senderId,
        candidate: computed.senderId
    });
    appendExactDifference({
        issues,
        path: 'computed.expectedVersion',
        expected: expected.expectedVersion,
        candidate: computed.expectedVersion
    });
    appendExactArrayDifferences({
        issues,
        path: 'computed.mutations',
        expected: expected.mutations,
        candidate: computed.mutations
    });
    appendExactArrayDifferences({
        issues,
        path: 'computed.durableEffects',
        expected: expected.durableEffects,
        candidate: computed.durableEffects
    });
    return issues;
}

function appendExactDataShapeDifference(
    input: AppendExactDataShapeDifferenceInput
): boolean {
    const { issues, path, expected, candidate } = input;
    try {
        const expectedKeys = Reflect.ownKeys(expected);
        const candidateKeys = Reflect.ownKeys(candidate);
        const expectedFieldsAreData = expectedKeys.every((key) =>
            Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(expected, key), 'value')
        );
        const candidateFieldsAreData = candidateKeys.every((key) =>
            Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(candidate, key), 'value')
        );
        const hasExactShape = Object.getPrototypeOf(expected) === Object.getPrototypeOf(candidate) &&
            expectedFieldsAreData && candidateFieldsAreData &&
            expectedKeys.length === candidateKeys.length &&
            expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(candidate, key));
        if (!hasExactShape) {
            issues.push(toALInboundAdmissionValidationIssue(path, 'has a different data shape'));
        }
        return expectedFieldsAreData && candidateFieldsAreData;
    }
    catch {
        issues.push(toALInboundAdmissionValidationIssue(path, 'must be inspectable inert data'));
        return false;
    }
}

function validateALInboundComputationFacts(
    facts: ALInboundComputationFacts
): ALInboundAdmissionValidationIssue[] {
    const issues: ALInboundAdmissionValidationIssue[] = [];
    if (typeof facts.selfPeerId !== 'string' || facts.selfPeerId.length === 0) {
        issues.push(toALInboundAdmissionValidationIssue('facts.selfPeerId', 'must be a non-empty string'));
    }
    if (typeof facts.inboxEntryTypeId !== 'string' || facts.inboxEntryTypeId.length === 0) {
        issues.push(toALInboundAdmissionValidationIssue('facts.inboxEntryTypeId', 'must be a non-empty string'));
    }
    if (typeof facts.messageIdentitySeed !== 'string' || facts.messageIdentitySeed.length === 0) {
        issues.push(toALInboundAdmissionValidationIssue('facts.messageIdentitySeed', 'must be a non-empty string'));
    }
    if (!Number.isSafeInteger(facts.observedAtEpochMs) || facts.observedAtEpochMs < 0) {
        issues.push(toALInboundAdmissionValidationIssue(
            'facts.observedAtEpochMs',
            'must be a non-negative safe integer'
        ));
    }
    if (!(facts.inboxAudit.date instanceof Temporal.PlainTime)) {
        issues.push(toALInboundAdmissionValidationIssue('facts.inboxAudit.date', 'must be a PlainTime'));
    }
    if (!(facts.inboxAudit.createdTs instanceof Temporal.PlainDateTime)) {
        issues.push(toALInboundAdmissionValidationIssue('facts.inboxAudit.createdTs', 'must be a PlainDateTime'));
    }
    return issues;
}

function appendExactArrayDifferences<Value>(
    input: AppendExactArrayDifferencesInput<Value>
): void {
    const { issues, path, expected, candidate } = input;
    if (!appendExactDataShapeDifference({ issues, path, expected, candidate })) {
        return;
    }
    if (expected.length !== candidate.length) {
        issues.push(toALInboundAdmissionValidationIssue(`${path}.length`, 'differs from the computed value'));
    }
    const comparedLength = Math.min(expected.length, candidate.length);
    for (let index = 0; index < comparedLength; index += 1) {
        appendExactDifference({
            issues,
            path: `${path}[${index}]`,
            expected: expected[index],
            candidate: candidate[index]
        });
    }
}

function appendExactDifference<Value>(
    input: AppendExactDifferenceInput<Value>
): void {
    const { issues, path, expected, candidate } = input;
    try {
        if (!isExactComputedValue(expected, candidate, { comparedCandidates: new WeakMap() })) {
            issues.push(toALInboundAdmissionValidationIssue(path, 'differs from the computed value'));
        }
    }
    catch {
        issues.push(toALInboundAdmissionValidationIssue(path, 'must be inspectable inert data'));
    }
}

function isExactComputedValue<Value>(
    expected: Value,
    candidate: Value,
    state: ExactValueComparisonState
): boolean {
    if (Object.is(expected, candidate)) {
        return true;
    }
    if (
        expected === null || candidate === null ||
        typeof expected !== 'object' || typeof candidate !== 'object'
    ) {
        return false;
    }
    if (expected instanceof Temporal.Instant) {
        return candidate instanceof Temporal.Instant && Temporal.Instant.compare(expected, candidate) === 0;
    }
    if (expected instanceof Temporal.PlainDateTime) {
        return candidate instanceof Temporal.PlainDateTime && Temporal.PlainDateTime.compare(expected, candidate) === 0;
    }
    if (expected instanceof Temporal.PlainTime) {
        return candidate instanceof Temporal.PlainTime && Temporal.PlainTime.compare(expected, candidate) === 0;
    }
    if (Object.getPrototypeOf(expected) !== Object.getPrototypeOf(candidate)) {
        return false;
    }

    const expectedObject = expected as object;
    const candidateObject = candidate as object;

    const compared = state.comparedCandidates.get(expectedObject) ?? new WeakSet<object>();
    if (compared.has(candidateObject)) {
        return true;
    }
    compared.add(candidateObject);
    state.comparedCandidates.set(expectedObject, compared);

    const expectedFields = Object.getOwnPropertyDescriptors(expectedObject);
    const candidateFields = Object.getOwnPropertyDescriptors(candidateObject);
    const expectedKeys = Reflect.ownKeys(expectedFields);
    const candidateKeys = Reflect.ownKeys(candidateFields);
    if (
        expectedKeys.length !== candidateKeys.length ||
        expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(candidateFields, key))
    ) {
        return false;
    }
    return expectedKeys.every((key) => {
        const expectedField = Object.getOwnPropertyDescriptor(expectedObject, key);
        const candidateField = Object.getOwnPropertyDescriptor(candidateObject, key);
        return Boolean(
            expectedField && candidateField &&
                Object.prototype.hasOwnProperty.call(expectedField, 'value') &&
                Object.prototype.hasOwnProperty.call(candidateField, 'value') &&
                isExactComputedValue(expectedField.value, candidateField.value, state)
        );
    });
}

function toALInboundAdmissionValidationIssue(
    path: string,
    reason: string
): ALInboundAdmissionValidationIssue {
    const message = `AL inbound ${path} ${reason}`;
    return { path, message, cause: new TypeError(message) };
}
