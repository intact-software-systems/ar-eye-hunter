import type { ApiJsonObject, ApiJsonValue } from '../api-json-value.ts';
import type { RallarValidationIssue } from '../rallar-validation.ts';

export function toKeyIssues(record: ApiJsonObject, keys: readonly string[], path: string): RallarValidationIssue[] {
    return [
        ...Object.keys(record).filter((key) => !keys.includes(key)).map((key) =>
            toIssue(`${path}.${key}`, 'unknown-key', `${key} is not a field of this record.`)
        ),
        ...keys.filter((key) => !Object.hasOwn(record, key)).map((key) =>
            toIssue(`${path}.${key}`, 'missing-key', `${key} is required.`)
        )
    ];
}

export function toNonEmptyStringIssues(
    record: ApiJsonObject,
    keys: readonly string[],
    path: string
): RallarValidationIssue[] {
    return presentKeys(record, keys)
        .filter((key) => !isNonEmptyString(record[key]))
        .map((key) => toIssue(`${path}.${key}`, 'invalid-string', `${key} must be a non-empty string.`));
}

export function presentKeys<Key extends string>(record: ApiJsonObject, keys: readonly Key[]): readonly Key[] {
    return keys.filter((key) => Object.hasOwn(record, key));
}

export function toIssue(path: string, code: string, message: string): RallarValidationIssue {
    return { path, code, message };
}

export function isNonEmptyString(value: ApiJsonValue): boolean {
    return typeof value === 'string' && value.length > 0;
}

export function isJsonObject(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
