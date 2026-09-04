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

interface AppendDifferenceInput<Value> {
    readonly path: string;
    readonly expected: Value;
    readonly candidate: Value;
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
        issues.push(toValidationIssue(
            'computed',
            `cannot be recomputed: ${error instanceof Error ? error.message : String(error)}`
        ));
        return issues;
    }

    try {
        if (!hasExactDataFields(computed, ['senderId', 'expectedVersion', 'mutations', 'durableEffects'])) {
            issues.push(toValidationIssue('computed', 'has a different data shape'));
            return issues;
        }
        appendDifference({
            path: 'computed.senderId',
            expected: expected.senderId,
            candidate: computed.senderId
        }, issues);
        appendDifference({
            path: 'computed.expectedVersion',
            expected: expected.expectedVersion,
            candidate: computed.expectedVersion
        }, issues);
        appendArrayDifferences(issues, 'computed.mutations', expected.mutations, computed.mutations);
        appendArrayDifferences(issues, 'computed.durableEffects', expected.durableEffects, computed.durableEffects);
    }
    catch {
        issues.push(toValidationIssue('computed', 'must be inspectable inert data'));
    }
    return issues;
}

function validateALInboundComputationFacts(
    facts: ALInboundComputationFacts
): ALInboundAdmissionValidationIssue[] {
    const issues: ALInboundAdmissionValidationIssue[] = [];
    if (typeof facts.selfPeerId !== 'string' || facts.selfPeerId.length === 0) {
        issues.push(toValidationIssue('facts.selfPeerId', 'must be a non-empty string'));
    }
    if (typeof facts.inboxEntryTypeId !== 'string' || facts.inboxEntryTypeId.length === 0) {
        issues.push(toValidationIssue('facts.inboxEntryTypeId', 'must be a non-empty string'));
    }
    if (typeof facts.messageIdentitySeed !== 'string' || facts.messageIdentitySeed.length === 0) {
        issues.push(toValidationIssue('facts.messageIdentitySeed', 'must be a non-empty string'));
    }
    if (!Number.isSafeInteger(facts.observedAtEpochMs) || facts.observedAtEpochMs < 0) {
        issues.push(toValidationIssue('facts.observedAtEpochMs', 'must be a non-negative safe integer'));
    }
    if (!(facts.inboxAudit.date instanceof Temporal.PlainTime)) {
        issues.push(toValidationIssue('facts.inboxAudit.date', 'must be a PlainTime'));
    }
    if (!(facts.inboxAudit.createdTs instanceof Temporal.PlainDateTime)) {
        issues.push(toValidationIssue('facts.inboxAudit.createdTs', 'must be a PlainDateTime'));
    }
    return issues;
}

function appendArrayDifferences<Value>(
    issues: ALInboundAdmissionValidationIssue[],
    path: string,
    expected: readonly Value[],
    candidate: readonly Value[]
): void {
    if (!hasExactArrayShape(candidate)) {
        issues.push(toValidationIssue(path, 'has a different data shape'));
        return;
    }
    if (expected.length !== candidate.length) {
        issues.push(toValidationIssue(`${path}.length`, 'differs from the computed value'));
    }
    for (let index = 0; index < Math.min(expected.length, candidate.length); index += 1) {
        appendDifference({
            path: `${path}[${index}]`,
            expected: expected[index],
            candidate: candidate[index]
        }, issues);
    }
}

function appendDifference<Value>(
    input: AppendDifferenceInput<Value>,
    issues: ALInboundAdmissionValidationIssue[]
): void {
    const { path, expected, candidate } = input;
    if (!isExactDataValue(expected, candidate)) {
        issues.push(toValidationIssue(path, 'differs from the computed value'));
    }
}

function isExactDataValue<Value>(
    expected: Value,
    candidate: Value
): boolean {
    if (Object.is(expected, candidate)) {
        return true;
    }
    if (expected instanceof Temporal.Instant) {
        return candidate instanceof Temporal.Instant && expected.equals(candidate);
    }
    if (expected instanceof Temporal.PlainDateTime) {
        return candidate instanceof Temporal.PlainDateTime && expected.equals(candidate);
    }
    if (expected instanceof Temporal.PlainTime) {
        return candidate instanceof Temporal.PlainTime && expected.equals(candidate);
    }
    if (
        expected === null || candidate === null ||
        typeof expected !== 'object' || typeof candidate !== 'object' ||
        Object.getPrototypeOf(expected) !== Object.getPrototypeOf(candidate)
    ) {
        return false;
    }

    const expectedFields = Object.getOwnPropertyDescriptors(expected);
    const candidateFields = Object.getOwnPropertyDescriptors(candidate);
    const expectedKeys = Reflect.ownKeys(expectedFields);
    const candidateKeys = Reflect.ownKeys(candidateFields);
    return expectedKeys.length === candidateKeys.length && expectedKeys.every((key) => {
        const expectedField = Object.getOwnPropertyDescriptor(expected, key);
        const candidateField = Object.getOwnPropertyDescriptor(candidate, key);
        return Boolean(
            expectedField && candidateField &&
                Object.prototype.hasOwnProperty.call(expectedField, 'value') &&
                Object.prototype.hasOwnProperty.call(candidateField, 'value') &&
                isExactDataValue(expectedField.value, candidateField.value)
        );
    });
}

function hasExactDataFields(candidate: object, fields: readonly string[]): boolean {
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    return Object.getPrototypeOf(candidate) === Object.prototype &&
        keys.length === fields.length &&
        fields.every((field) => {
            const descriptor = descriptors[field];
            return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value');
        });
}

function hasExactArrayShape<Value>(candidate: readonly Value[]): boolean {
    if (!Array.isArray(candidate) || Object.getPrototypeOf(candidate) !== Array.prototype) {
        return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    return Reflect.ownKeys(descriptors).length === candidate.length + 1;
}

function toValidationIssue(
    path: string,
    reason: string
): ALInboundAdmissionValidationIssue {
    const message = `AL inbound ${path} ${reason}`;
    return { path, message, cause: new TypeError(message) };
}
