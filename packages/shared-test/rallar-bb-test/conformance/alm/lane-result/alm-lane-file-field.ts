import { isApiJsonObject, type ApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';

/** One member of a file the ALM lane's ledger reads: its path from the file's root, and the value found there. */
export interface AlmLaneFileField {
    readonly path: string;
    readonly value: ApiJsonValue | undefined;
}

export type AlmLaneFieldValidation = (field: AlmLaneFileField) => readonly string[];

/** A file's text as JSON; undefined when it is not JSON. Only the parse is guarded, so no decoder error reads as such. */
export function decodeJsonText(text: string): ApiJsonValue | undefined {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}

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

/** Names each text a list of texts holds more than once. */
export function validateUniqueEntries(field: AlmLaneFileField): readonly string[] {
    const entries = Array.isArray(field.value) ? field.value : [];
    return toRepeatedTexts(entries).map((text) => `${field.path} names ${JSON.stringify(text)} more than once.`);
}

/** Names each text that the given key of a list's entries holds more than once. */
export function validateUniqueKey(field: AlmLaneFileField, key: string): readonly string[] {
    const entries = Array.isArray(field.value) ? field.value : [];
    const texts = entries.map((entry) => isApiJsonObject(entry) ? entry[key] : undefined);
    return toRepeatedTexts(texts).map((text) => `${field.path} names ${key} ${JSON.stringify(text)} more than once.`);
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

function toRepeatedTexts(values: readonly (ApiJsonValue | undefined)[]): readonly string[] {
    const texts = values.filter((value) => typeof value === 'string');
    return [...new Set(texts.filter((text, index) => texts.indexOf(text) !== index))];
}
