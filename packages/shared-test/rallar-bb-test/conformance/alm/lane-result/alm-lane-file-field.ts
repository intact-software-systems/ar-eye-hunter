import { isApiJsonObject, type ApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';

/** One member of a file the ALM lane's ledger reads: its path from the file's root, and the value found there. */
export interface AlmLaneFileField {
    readonly path: string;
    readonly value: ApiJsonValue | undefined;
}

export type AlmLaneFieldValidation = (field: AlmLaneFileField) => readonly string[];

export function toField(record: ApiJsonObject, key: string, parentPath = ''): AlmLaneFileField {
    return { path: parentPath === '' ? key : `${parentPath}.${key}`, value: record[key] };
}

export function validateMember(field: AlmLaneFileField, accepted: readonly string[]): readonly string[] {
    return typeof field.value === 'string' && accepted.includes(field.value)
        ? []
        : [toIssue(field, `one of ${accepted.join(', ')}`)];
}

export function validateText(field: AlmLaneFileField): readonly string[] {
    return typeof field.value === 'string' && field.value.length > 0 ? [] : [toIssue(field, 'a non-empty string')];
}

export function validateObject(
    field: AlmLaneFileField,
    validateMembers: (record: ApiJsonObject) => readonly string[]
): readonly string[] {
    return isApiJsonObject(field.value) ? validateMembers(field.value) : [toIssue(field, 'an object')];
}

export function validateList(field: AlmLaneFileField, validateEntry: AlmLaneFieldValidation): readonly string[] {
    if (!Array.isArray(field.value)) {
        return [toIssue(field, 'an array')];
    }
    return field.value.flatMap((entry, index) => validateEntry({ path: `${field.path}[${index}]`, value: entry }));
}

/** Names each text a list holds more than once: the entry itself, or the named key of each entry. */
export function validateUnique(field: AlmLaneFileField, key: string | undefined): readonly string[] {
    const entries = Array.isArray(field.value) ? field.value : [];
    const texts = entries.map((entry) => key === undefined ? entry : isApiJsonObject(entry) ? entry[key] : undefined)
        .filter((text) => typeof text === 'string');
    const repeated = [...new Set(texts.filter((text, index) => texts.indexOf(text) !== index))];
    const named = key === undefined ? '' : `${key} `;
    return repeated.map((text) => `${field.path} names ${named}${JSON.stringify(text)} more than once.`);
}

export function toIssue(field: AlmLaneFileField, expected: string): string {
    return field.value === undefined
        ? `${field.path} is missing; expected ${expected}.`
        : `${field.path} is ${toReceivedText(field.value)}; expected ${expected}.`;
}

function toReceivedText(value: ApiJsonValue): string {
    if (Array.isArray(value)) {
        return 'an array';
    }
    return value !== null && typeof value === 'object' ? 'an object' : JSON.stringify(value);
}
