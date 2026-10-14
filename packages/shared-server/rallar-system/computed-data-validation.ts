import { Temporal } from '@js-temporal/polyfill';
import { types } from 'node:util';

import { Either } from '@shared/resilience/Either.ts';

export interface ComputedDataValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: TypeError;
}

interface ComputedDataValidationState {
    readonly ancestors: Set<object>;
    readonly issues: ComputedDataValidationIssue[];
}

interface ComputedProjectionValidationState {
    readonly comparedCandidates: WeakMap<object, WeakSet<object>>;
    readonly issues: ComputedDataValidationIssue[];
}

interface ComputedProjectionComparison<Expected, Candidate> {
    readonly expected: Expected;
    readonly candidate: Candidate;
    readonly path: string;
}

/** Rejects executable and opaque values before a domain validator reads candidate fields. */
export function validateComputedData<Candidate>(
    candidate: Candidate,
    path: string
): readonly ComputedDataValidationIssue[] {
    const state: ComputedDataValidationState = { ancestors: new Set(), issues: [] };
    validateComputedDataValue(candidate, path, state);
    return state.issues;
}

/** Compares the complete candidate only after proving that candidate property reads are inert. */
export function validateComputedProjection<Expected, Candidate>(
    expected: Expected,
    candidate: Candidate,
    path: string
): readonly ComputedDataValidationIssue[] {
    const dataIssues = validateComputedData(candidate, path);
    if (dataIssues.length > 0) {
        return dataIssues;
    }
    const state: ComputedProjectionValidationState = {
        comparedCandidates: new WeakMap(),
        issues: []
    };
    compareComputedProjection({ expected, candidate, path }, state);
    return state.issues;
}

/** Preserves envelope descriptors until inert-data validation has rejected executable fields. */
export function validateComputedEitherProjection<Left, Right>(
    expected: Either<Left, Right>,
    candidate: Either<Left, Right>,
    path: string
): readonly ComputedDataValidationIssue[] {
    if (typeof candidate !== 'object' || candidate === null) {
        return [toComputedDataValidationIssue(path, 'must be an Either result')];
    }
    if (types.isProxy(candidate)) {
        return [toComputedDataValidationIssue(path, 'must be inert data')];
    }
    if (Object.getPrototypeOf(candidate) !== Either.prototype) {
        return [toComputedDataValidationIssue(path, 'must be an Either result')];
    }
    return validateComputedProjection(
        { left: expected.left, right: expected.right },
        Object.defineProperties({}, Object.getOwnPropertyDescriptors(candidate)),
        path
    );
}

function validateComputedDataValue<Value>(
    value: Value,
    path: string,
    state: ComputedDataValidationState
): void {
    if (typeof value === 'function' || typeof value === 'symbol') {
        state.issues.push(toComputedDataValidationIssue(path, 'must be inert data'));
        return;
    }
    if (value === null || typeof value !== 'object') {
        return;
    }
    if (hasProxyInPrototypeChain(value)) {
        state.issues.push(toComputedDataValidationIssue(path, 'must be inert data'));
        return;
    }
    if (!isSupportedComputedDataObject(value)) {
        state.issues.push(toComputedDataValidationIssue(path, 'has an unsupported data shape'));
        return;
    }
    if (state.ancestors.has(value)) {
        state.issues.push(toComputedDataValidationIssue(path, 'must not contain a cycle'));
        return;
    }
    if (!hasReadableAtomicComputedDataValue(value)) {
        state.issues.push(toComputedDataValidationIssue(path, 'must have a readable atomic data value'));
    }

    state.ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const fieldPath = `${path}.${String(key)}`;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            state.issues.push(toComputedDataValidationIssue(fieldPath, 'must be a data property'));
            continue;
        }
        validateComputedDataValue(descriptor.value, fieldPath, state);
    }
    state.ancestors.delete(value);
}

function compareComputedProjection<Expected, Candidate>(
    comparison: ComputedProjectionComparison<Expected, Candidate>,
    state: ComputedProjectionValidationState
): void {
    const { expected, candidate, path } = comparison;
    if (Object.is(expected, candidate)) {
        return;
    }
    if (
        expected === null || candidate === null ||
        typeof expected !== 'object' || typeof candidate !== 'object'
    ) {
        state.issues.push(toComputedDataValidationIssue(path, 'differs from the computed value'));
        return;
    }
    if (!hasSameComputedDataShape(expected, candidate)) {
        state.issues.push(toComputedDataValidationIssue(path, 'has a different data shape'));
        return;
    }
    if (isAtomicComputedDataObject(expected) && !hasSameAtomicComputedDataValue(expected, candidate)) {
        state.issues.push(toComputedDataValidationIssue(path, 'differs from the computed value'));
        return;
    }
    const compared = state.comparedCandidates.get(expected) ?? new WeakSet<object>();
    if (compared.has(candidate)) {
        return;
    }
    compared.add(candidate);
    state.comparedCandidates.set(expected, compared);
    compareComputedDataProperties({ expected, candidate, path }, state);
}

function compareComputedDataProperties(
    comparison: ComputedProjectionComparison<object, object>,
    state: ComputedProjectionValidationState
): void {
    const { expected, candidate, path } = comparison;
    const expectedFields = Object.getOwnPropertyDescriptors(expected);
    const candidateFields = Object.getOwnPropertyDescriptors(candidate);
    for (const key of Reflect.ownKeys(expectedFields)) {
        const fieldPath = `${path}.${String(key)}`;
        const expectedField = Object.getOwnPropertyDescriptor(expected, key);
        const candidateField = Object.getOwnPropertyDescriptor(candidate, key);
        if (
            !expectedField || !candidateField ||
            !Object.prototype.hasOwnProperty.call(expectedField, 'value') ||
            !Object.prototype.hasOwnProperty.call(candidateField, 'value')
        ) {
            state.issues.push(toComputedDataValidationIssue(fieldPath, 'must be the computed data property'));
            continue;
        }
        compareComputedProjection(
            { expected: expectedField.value, candidate: candidateField.value, path: fieldPath },
            state
        );
    }
    for (const key of Reflect.ownKeys(candidateFields)) {
        if (!Object.prototype.hasOwnProperty.call(expectedFields, key)) {
            state.issues.push(
                toComputedDataValidationIssue(`${path}.${String(key)}`, 'is not part of the computed value')
            );
        }
    }
}

function isSupportedComputedDataObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ||
        Array.isArray(value) || isAtomicComputedDataObject(value);
}

function hasProxyInPrototypeChain(value: object): boolean {
    let current: object | null = value;
    while (current !== null) {
        if (types.isProxy(current)) {
            return true;
        }
        current = Object.getPrototypeOf(current);
    }
    return false;
}

function hasReadableAtomicComputedDataValue(value: object): boolean {
    // Intrinsic receivers reject forged brands without consulting candidate properties.
    try {
        if (ArrayBuffer.isView(value)) {
            toBytes(value);
            return true;
        }
        switch (Object.getPrototypeOf(value)) {
            case Date.prototype:
                Date.prototype.getTime.call(value);
                break;
            case Temporal.Instant.prototype:
                Reflect.get(Temporal.Instant.prototype, 'epochNanoseconds', value);
                break;
            case Temporal.PlainDateTime.prototype:
                Reflect.get(Temporal.PlainDateTime.prototype, 'calendarId', value);
                break;
            case Temporal.PlainTime.prototype:
                Reflect.get(Temporal.PlainTime.prototype, 'hour', value);
                break;
        }
        return true;
    }
    catch {
        return false;
    }
}

function hasSameComputedDataShape(expected: object, candidate: object): boolean {
    return Object.getPrototypeOf(expected) === Object.getPrototypeOf(candidate) &&
        Array.isArray(expected) === Array.isArray(candidate) &&
        ArrayBuffer.isView(expected) === ArrayBuffer.isView(candidate);
}

function hasSameAtomicComputedDataValue(expected: object, candidate: object): boolean {
    switch (Object.getPrototypeOf(expected)) {
        case Date.prototype:
            return Date.prototype.getTime.call(expected) === Date.prototype.getTime.call(candidate);
        case Temporal.Instant.prototype:
            return Temporal.Instant.compare(expected as Temporal.Instant, candidate as Temporal.Instant) === 0;
        case Temporal.PlainDateTime.prototype:
            return Temporal.PlainDateTime.compare(
                expected as Temporal.PlainDateTime,
                candidate as Temporal.PlainDateTime
            ) === 0;
        case Temporal.PlainTime.prototype:
            return Temporal.PlainTime.compare(expected as Temporal.PlainTime, candidate as Temporal.PlainTime) === 0;
    }
    if (ArrayBuffer.isView(expected) && ArrayBuffer.isView(candidate)) {
        const expectedBytes = toBytes(expected);
        const candidateBytes = toBytes(candidate);
        return expectedBytes.length === candidateBytes.length &&
            expectedBytes.every((value, index) => value === candidateBytes[index]);
    }
    return false;
}

function toBytes(value: ArrayBufferView): Uint8Array {
    const prototype = types.isDataView(value) ? DataView.prototype : Object.getPrototypeOf(Uint8Array.prototype);
    return new Uint8Array(
        Reflect.get(prototype, 'buffer', value),
        Reflect.get(prototype, 'byteOffset', value),
        Reflect.get(prototype, 'byteLength', value)
    );
}

function isAtomicComputedDataObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return ArrayBuffer.isView(value) ||
        prototype === Date.prototype ||
        prototype === Temporal.Instant.prototype ||
        prototype === Temporal.PlainDateTime.prototype ||
        prototype === Temporal.PlainTime.prototype;
}

function toComputedDataValidationIssue(
    path: string,
    reason: string
): ComputedDataValidationIssue {
    const message = `${path} ${reason}`;
    return { path, message, cause: new TypeError(message) };
}
