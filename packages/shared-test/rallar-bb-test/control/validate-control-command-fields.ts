import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import type { RallarBlackBoxCommandFieldSet } from '../schema/rallar-black-box-command-fields.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';

export interface ControlCommandIntegerFieldInput {
    readonly record: RallarBlackBoxTestRecord;
    readonly key: string;
    readonly path: string;
    /** Absent when the field has no lower bound. */
    readonly minimum?: number;
    /** Absent when the field has no upper bound. */
    readonly maximum?: number;
}

export interface ControlCommandEnumFieldInput {
    readonly record: RallarBlackBoxTestRecord;
    readonly key: string;
    readonly path: string;
    readonly allowed: readonly string[];
}

export interface ControlCommandRequiredFieldsInput {
    readonly record: RallarBlackBoxTestRecord;
    readonly fields: RallarBlackBoxCommandFieldSet;
    readonly path: string;
    /** Required fields whose own validator reports their absence in its own words. */
    readonly ownMessageFields: readonly string[];
}

const NO_ISSUES: readonly ControlCommandIssue[] = [];

export function validateAllowedFields(
    record: RallarBlackBoxTestRecord,
    fields: RallarBlackBoxCommandFieldSet,
    path: string
): readonly ControlCommandIssue[] {
    return Object.keys(record)
        .filter((key) => !fields.required.includes(key) && !fields.optional.includes(key))
        .map((key) => toControlCommandIssue(`${path} has unsupported field: ${key}.`));
}

export function validateRequiredFields(input: ControlCommandRequiredFieldsInput): readonly ControlCommandIssue[] {
    const { record, fields, path, ownMessageFields } = input;
    return fields.required
        .filter((key) => record[key] === undefined && !ownMessageFields.includes(key))
        .map((key) => toControlCommandIssue(`${path}.${key} is required.`));
}

export function validateStringField(
    record: RallarBlackBoxTestRecord,
    key: string,
    path: string
): readonly ControlCommandIssue[] {
    const value = record[key];
    return value === undefined || typeof value === 'string'
        ? NO_ISSUES
        : [toControlCommandIssue(`${path}.${key} must be a string.`)];
}

export function validateNumberField(
    record: RallarBlackBoxTestRecord,
    key: string,
    path: string
): readonly ControlCommandIssue[] {
    const value = record[key];
    if (value === undefined) {
        return NO_ISSUES;
    }
    if (typeof value !== 'number') {
        return [toControlCommandIssue(`${path}.${key} must be a number.`)];
    }
    return Number.isFinite(value) ? NO_ISSUES : [toControlCommandIssue(`${path}.${key} must be a finite number.`)];
}

export function validateNonNegativeNumberFields(
    record: RallarBlackBoxTestRecord,
    keys: readonly string[],
    path: string
): readonly ControlCommandIssue[] {
    return keys.flatMap((key) => {
        const numberIssues = validateNumberField(record, key, path);
        const value = record[key];
        return numberIssues.length === 0 && typeof value === 'number' && value < 0
            ? [toControlCommandIssue(`${path}.${key} must be >= 0.`)]
            : numberIssues;
    });
}

export function validateRatioField(
    record: RallarBlackBoxTestRecord,
    key: string,
    path: string
): readonly ControlCommandIssue[] {
    const numberIssues = validateNumberField(record, key, path);
    const value = record[key];
    return numberIssues.length === 0 && typeof value === 'number' && (value < 0 || value > 1)
        ? [toControlCommandIssue(`${path}.${key} must be between 0 and 1.`)]
        : numberIssues;
}

export function validateIntegerField(input: ControlCommandIntegerFieldInput): readonly ControlCommandIssue[] {
    const { record, key, path, minimum, maximum } = input;
    const value = record[key];
    if (value === undefined) {
        return NO_ISSUES;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        return [toControlCommandIssue(`${path}.${key} must be an integer.`)];
    }
    if (minimum !== undefined && value < minimum) {
        return [toControlCommandIssue(`${path}.${key} must be >= ${minimum}.`)];
    }
    return maximum !== undefined && value > maximum
        ? [toControlCommandIssue(`${path}.${key} must be <= ${maximum}.`)]
        : NO_ISSUES;
}

export function validateBooleanField(
    record: RallarBlackBoxTestRecord,
    key: string,
    path: string
): readonly ControlCommandIssue[] {
    const value = record[key];
    return value === undefined || typeof value === 'boolean'
        ? NO_ISSUES
        : [toControlCommandIssue(`${path}.${key} must be a boolean.`)];
}

export function validateEnumField(input: ControlCommandEnumFieldInput): readonly ControlCommandIssue[] {
    const { record, key, path, allowed } = input;
    const value = record[key];
    return value === undefined || (typeof value === 'string' && allowed.includes(value))
        ? NO_ISSUES
        : [toControlCommandIssue(`${path}.${key} must be one of ${allowed.join(', ')}.`)];
}

export function validateObjectField(
    record: RallarBlackBoxTestRecord,
    key: string,
    path: string
): readonly ControlCommandIssue[] {
    const value = record[key];
    return value === undefined || isJsonRecordValue(value)
        ? NO_ISSUES
        : [toControlCommandIssue(`${path}.${key} must be an object.`)];
}

export function validateStringRecordField(
    record: RallarBlackBoxTestRecord,
    key: string,
    path: string
): readonly ControlCommandIssue[] {
    const value = record[key];
    if (value === undefined) {
        return NO_ISSUES;
    }
    if (!isJsonRecordValue(value)) {
        return [toControlCommandIssue(`${path}.${key} must be an object.`)];
    }
    return Object.entries(value)
        .filter(([, entry]) => typeof entry !== 'string')
        .map(([entryKey]) => toControlCommandIssue(`${path}.${key}.${entryKey} must be a string.`));
}
