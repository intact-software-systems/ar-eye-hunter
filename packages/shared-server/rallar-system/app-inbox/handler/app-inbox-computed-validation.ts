import { Temporal } from '@js-temporal/polyfill';
import { types } from 'node:util';

export interface AppInboxComputedValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: TypeError;
}

interface ComputedDataValidation {
    readonly ancestors: Set<object>;
    readonly issues: AppInboxComputedValidationIssue[];
}

interface ComputedProjectionValidation {
    readonly validatedCandidatesByExpected: WeakMap<object, WeakSet<object>>;
}

type ComputedProjectionValue = object | null | undefined | string | number | bigint | boolean | symbol;

interface ComputedProjectionLocation {
    readonly path: string;
    readonly validation: ComputedProjectionValidation;
}

/** Checks data safety before field access; domain validators still own value correctness. */
export function validateAppInboxComputedData(
    candidate: unknown,
    path: string
): readonly AppInboxComputedValidationIssue[] {
    const validation: ComputedDataValidation = { ancestors: new Set(), issues: [] };
    validateComputedDataProperties(candidate, path, validation);
    return validation.issues;
}

function validateComputedDataProperties(value: unknown, path: string, validation: ComputedDataValidation): void {
    if (types.isProxy(value) || typeof value === 'function') {
        validation.issues.push(toAppInboxComputedValidationIssue(path, 'must be data, not executable behavior'));
        return;
    }
    if (value === null || typeof value !== 'object') {
        return;
    }
    if (!isSupportedComputedObject(value)) {
        validation.issues.push(toAppInboxComputedValidationIssue(path, 'has an unsupported computed data shape'));
        return;
    }
    if (validation.ancestors.has(value)) {
        validation.issues.push(toAppInboxComputedValidationIssue(path, 'must not contain a cycle'));
        return;
    }
    validation.ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
        // Stack formatting is not persisted data and can execute V8's lazy stack formatter.
        if (types.isNativeError(value) && key === 'stack') {
            continue;
        }
        const field = Reflect.getOwnPropertyDescriptor(value, key)!;
        const fieldPath = `${path}.${String(key)}`;
        if (!('value' in field)) {
            validation.issues.push(toAppInboxComputedValidationIssue(fieldPath, 'must be a data property'));
            continue;
        }
        validateComputedDataProperties(field.value, fieldPath, validation);
    }
    validation.ancestors.delete(value);
}

export function validateAppInboxComputedProjection(
    expected: unknown,
    candidate: unknown,
    path: string
): readonly AppInboxComputedValidationIssue[] {
    return validateComputedProjection(expected as ComputedProjectionValue, candidate as ComputedProjectionValue, {
        path,
        validation: { validatedCandidatesByExpected: new WeakMap() }
    });
}

function validateComputedProjection(
    expected: ComputedProjectionValue,
    candidate: ComputedProjectionValue,
    location: ComputedProjectionLocation
): AppInboxComputedValidationIssue[] {
    const { path, validation } = location;
    if (types.isProxy(candidate)) {
        return [toAppInboxComputedValidationIssue(path, 'must be data, not a proxy')];
    }
    if (expected === null || typeof expected !== 'object') {
        return Object.is(expected, candidate)
            ? []
            : [toAppInboxComputedValidationIssue(path, 'differs from the computed value')];
    }
    if (candidate === null || typeof candidate !== 'object') {
        return [toAppInboxComputedValidationIssue(path, 'has a different value shape')];
    }
    if (validation.validatedCandidatesByExpected.get(expected)?.has(candidate)) {
        return [];
    }
    if (!isSupportedComputedObject(expected)) {
        return [toAppInboxComputedValidationIssue(path, 'has an unsupported computed data shape')];
    }
    if (
        Array.isArray(expected) !== Array.isArray(candidate) ||
        types.isTypedArray(expected) !== types.isTypedArray(candidate) ||
        types.isNativeError(expected) !== types.isNativeError(candidate)
    ) {
        return [toAppInboxComputedValidationIssue(path, 'has a different native data shape')];
    }
    let candidateFields: PropertyDescriptorMap;
    try {
        if (Object.getPrototypeOf(candidate) !== Object.getPrototypeOf(expected)) {
            return [toAppInboxComputedValidationIssue(path, 'has a different value shape')];
        }
        candidateFields = Object.getOwnPropertyDescriptors(candidate);
    }
    catch {
        return [toAppInboxComputedValidationIssue(path, 'cannot be inspected as computed data')];
    }
    const issues = validateComputedOwnProperties(expected, candidateFields, { path, validation });
    if (!hasMatchingComputedTimestamp(expected, candidate)) {
        issues.push(toAppInboxComputedValidationIssue(path, 'differs from the computed timestamp'));
    }
    if (issues.length === 0) {
        const candidates = validation.validatedCandidatesByExpected.get(expected) ?? new WeakSet<object>();
        candidates.add(candidate);
        validation.validatedCandidatesByExpected.set(expected, candidates);
    }
    return issues;
}

export function toAppInboxComputedValidationIssue(path: string, reason: string): AppInboxComputedValidationIssue {
    const message = `AppInbox ${path} ${reason}`;
    return { path, message, cause: new TypeError(message) };
}

function validateComputedOwnProperties(
    expected: object,
    candidateFields: PropertyDescriptorMap,
    location: ComputedProjectionLocation
): AppInboxComputedValidationIssue[] {
    const { path, validation } = location;
    const issues: AppInboxComputedValidationIssue[] = [];
    const expectedFields = Object.getOwnPropertyDescriptors(expected);
    for (const key of Reflect.ownKeys(expectedFields)) {
        if (expected instanceof Error && key === 'stack') {
            continue;
        }
        const expectedField = Reflect.getOwnPropertyDescriptor(expected, key)!;
        const candidateField = candidateFields[key];
        const fieldPath = `${path}.${String(key)}`;
        if (!candidateField || !('value' in candidateField) || candidateField.enumerable !== expectedField.enumerable) {
            issues.push(toAppInboxComputedValidationIssue(fieldPath, 'must be the computed data property'));
            continue;
        }
        issues.push(...validateComputedProjection(
            expectedField.value,
            candidateField.value,
            { path: fieldPath, validation }
        ));
    }
    for (const key of Reflect.ownKeys(candidateFields)) {
        if (expected instanceof Error && key === 'stack') {
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(expectedFields, key)) {
            issues.push(
                toAppInboxComputedValidationIssue(`${path}.${String(key)}`, 'is not part of the computed value')
            );
        }
    }
    return issues;
}

function isSupportedComputedObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
        return prototype === Array.prototype;
    }
    if (types.isProxy(prototype)) {
        return false;
    }
    return prototype === Object.prototype || prototype === null ||
        types.isDate(value) || types.isNativeError(value) || types.isTypedArray(value) ||
        prototype === Temporal.Instant.prototype || prototype === Temporal.PlainDateTime.prototype ||
        prototype === Temporal.PlainTime.prototype;
}

function hasMatchingComputedTimestamp(expected: object, candidate: object): boolean {
    try {
        if (expected instanceof Date) {
            return Date.prototype.getTime.call(expected) === Date.prototype.getTime.call(candidate);
        }
        if (expected instanceof Temporal.Instant) {
            return Temporal.Instant.prototype.equals.call(candidate as Temporal.Instant, expected);
        }
        if (expected instanceof Temporal.PlainDateTime) {
            return Temporal.PlainDateTime.prototype.equals.call(candidate as Temporal.PlainDateTime, expected);
        }
        if (expected instanceof Temporal.PlainTime) {
            return Temporal.PlainTime.prototype.equals.call(candidate as Temporal.PlainTime, expected);
        }
        return true;
    }
    catch {
        return false;
    }
}

