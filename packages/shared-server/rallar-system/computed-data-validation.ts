import { Temporal } from '@js-temporal/polyfill';
import { types } from 'node:util';

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

interface ComputedProjectionComparison {
    readonly expected: unknown;
    readonly candidate: unknown;
    readonly path: string;
}

/** Rejects executable and opaque values before a domain validator reads candidate fields. */
export function validateComputedData(
    candidate: unknown,
    path: string
): readonly ComputedDataValidationIssue[] {
    const state: ComputedDataValidationState = { ancestors: new Set(), issues: [] };
    validateComputedDataValue(candidate, path, state);
    return state.issues;
}

/** Compares the complete candidate only after proving that candidate property reads are inert. */
export function validateComputedProjection(
    expected: unknown,
    candidate: unknown,
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

function validateComputedDataValue(
    value: unknown,
    path: string,
    state: ComputedDataValidationState
): void {
    if (types.isProxy(value) || typeof value === 'function' || typeof value === 'symbol') {
        state.issues.push(toComputedDataValidationIssue(path, 'must be inert data'));
        return;
    }
    if (value === null || typeof value !== 'object') {
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
    if (isAtomicComputedDataObject(value)) {
        return;
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

function compareComputedProjection(
    comparison: ComputedProjectionComparison,
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
    if (isAtomicComputedDataObject(expected)) {
        if (!hasSameAtomicComputedDataValue(expected, candidate)) {
            state.issues.push(toComputedDataValidationIssue(path, 'differs from the computed value'));
        }
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
    comparison: Readonly<ComputedProjectionComparison & { expected: object; candidate: object; }>,
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
        Array.isArray(value) || ArrayBuffer.isView(value) ||
        prototype === Date.prototype ||
        prototype === Temporal.Instant.prototype ||
        prototype === Temporal.PlainDateTime.prototype ||
        prototype === Temporal.PlainTime.prototype;
}

function hasSameComputedDataShape(expected: object, candidate: object): boolean {
    return Object.getPrototypeOf(expected) === Object.getPrototypeOf(candidate) &&
        Array.isArray(expected) === Array.isArray(candidate) &&
        ArrayBuffer.isView(expected) === ArrayBuffer.isView(candidate);
}

function hasSameAtomicComputedDataValue(expected: object, candidate: object): boolean {
    if (expected instanceof Date && candidate instanceof Date) {
        return Date.prototype.getTime.call(expected) === Date.prototype.getTime.call(candidate);
    }
    if (expected instanceof Temporal.Instant && candidate instanceof Temporal.Instant) {
        return Temporal.Instant.compare(expected, candidate) === 0;
    }
    if (expected instanceof Temporal.PlainDateTime && candidate instanceof Temporal.PlainDateTime) {
        return Temporal.PlainDateTime.compare(expected, candidate) === 0;
    }
    if (expected instanceof Temporal.PlainTime && candidate instanceof Temporal.PlainTime) {
        return Temporal.PlainTime.compare(expected, candidate) === 0;
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
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function isAtomicComputedDataObject(value: object): boolean {
    return ArrayBuffer.isView(value) ||
        value instanceof Date ||
        value instanceof Temporal.Instant ||
        value instanceof Temporal.PlainDateTime ||
        value instanceof Temporal.PlainTime;
}

function toComputedDataValidationIssue(
    path: string,
    reason: string
): ComputedDataValidationIssue {
    const message = `${path} ${reason}`;
    return { path, message, cause: new TypeError(message) };
}
