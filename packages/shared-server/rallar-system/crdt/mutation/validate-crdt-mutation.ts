import { Temporal } from '@js-temporal/polyfill';

import { computeCrdtMutation } from './compute-crdt-mutation.ts';
import type {
    CrdtMutationComputed,
    CrdtMutationValidationIssue,
    ValidateCrdtMutationInput
} from './crdt-mutation-contracts.ts';

type CrdtComputedComparable =
    | object
    | string
    | number
    | boolean
    | bigint
    | symbol
    | null
    | undefined;

interface IsExactCrdtObjectInput {
    readonly actual: object;
    readonly expected: object;
    readonly compared: WeakMap<object, object>;
}

interface IsExactCrdtDataPropertyInput {
    readonly actual: object;
    readonly expected: object;
    readonly key: string;
    readonly compared: WeakMap<object, object>;
}

export function validateCrdtMutation(
    input: ValidateCrdtMutationInput
): readonly CrdtMutationValidationIssue[] {
    let expected: CrdtMutationComputed;
    try {
        expected = computeCrdtMutation({
            command: input.command,
            read: input.read,
            serviceId: input.serviceId
        });
    }
    catch (caught) {
        return [{
            code: 'computed-input-invalid',
            message: caught instanceof Error ? caught.message : String(caught)
        }];
    }

    try {
        if (
            input.computed.command !== input.command ||
            input.computed.read !== input.read ||
            !isExactCrdtComputedValue(input.computed, expected, new WeakMap())
        ) {
            return [{
                code: 'computed-mutation-differs',
                message: 'CRDT computed mutation differs from canonical computation'
            }];
        }
    }
    catch {
        return [{
            code: 'computed-mutation-differs',
            message: 'CRDT computed mutation differs from canonical computation'
        }];
    }
    return [];
}

function isExactCrdtComputedValue(
    actual: CrdtComputedComparable,
    expected: CrdtComputedComparable,
    compared: WeakMap<object, object>
): boolean {
    if (Object.is(actual, expected)) {
        return true;
    }
    if (actual instanceof Date || expected instanceof Date) {
        return actual instanceof Date &&
            expected instanceof Date &&
            Date.prototype.getTime.call(actual) === Date.prototype.getTime.call(expected);
    }
    if (actual instanceof Temporal.Instant || expected instanceof Temporal.Instant) {
        return actual instanceof Temporal.Instant &&
            expected instanceof Temporal.Instant &&
            Temporal.Instant.compare(actual, expected) === 0;
    }
    if (actual instanceof Temporal.PlainDateTime || expected instanceof Temporal.PlainDateTime) {
        return actual instanceof Temporal.PlainDateTime &&
            expected instanceof Temporal.PlainDateTime &&
            Temporal.PlainDateTime.compare(actual, expected) === 0;
    }
    if (actual instanceof Temporal.PlainTime || expected instanceof Temporal.PlainTime) {
        return actual instanceof Temporal.PlainTime &&
            expected instanceof Temporal.PlainTime &&
            Temporal.PlainTime.compare(actual, expected) === 0;
    }
    if (
        typeof actual !== 'object' ||
        actual === null ||
        typeof expected !== 'object' ||
        expected === null
    ) {
        return false;
    }
    return isExactCrdtObject({ actual, expected, compared });
}

function isExactCrdtObject(input: IsExactCrdtObjectInput): boolean {
    const { actual, expected, compared } = input;
    const prior = compared.get(actual);
    if (prior !== undefined) {
        return prior === expected;
    }
    compared.set(actual, expected);

    if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) {
        return false;
    }

    const actualKeys = readCrdtObjectKeys(actual);
    const expectedKeys = readCrdtObjectKeys(expected);
    if (actualKeys === null || expectedKeys === null) {
        return false;
    }
    return actualKeys.length === expectedKeys.length &&
        actualKeys.every((key, index) =>
            key === expectedKeys[index] &&
            isExactCrdtDataProperty({ actual, expected, key, compared })
        );
}

function readCrdtObjectKeys(value: object): readonly string[] | null {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
        return null;
    }
    return (keys as string[]).toSorted();
}

function isExactCrdtDataProperty(input: IsExactCrdtDataPropertyInput): boolean {
    const { actual, expected, key, compared } = input;
    const actualDescriptor = Object.getOwnPropertyDescriptor(actual, key);
    const expectedDescriptor = Object.getOwnPropertyDescriptor(expected, key);
    return actualDescriptor !== undefined &&
        expectedDescriptor !== undefined &&
        Object.hasOwn(actualDescriptor, 'value') &&
        Object.hasOwn(expectedDescriptor, 'value') &&
        isExactCrdtComputedValue(
            actualDescriptor.value as CrdtComputedComparable,
            expectedDescriptor.value as CrdtComputedComparable,
            compared
        );
}
