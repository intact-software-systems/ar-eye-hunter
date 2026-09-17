import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

export function isStoredJsonObject(value: ApiJsonValue | undefined): value is ApiJsonObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The cached text, or `undefined` when the entry does not hold a string. */
export function decodeStoredText(value: ApiJsonValue | undefined): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** The cached number, or `undefined` when the entry does not hold a finite number. */
export function decodeStoredNumber(value: ApiJsonValue | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The cached flag, or `undefined` when the entry does not hold a boolean. */
export function decodeStoredBoolean(value: ApiJsonValue | undefined): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

/** The cached member, or `undefined` when the entry does not hold one of the members. */
export function decodeStoredMember<Member extends string>(
    value: ApiJsonValue | undefined,
    members: readonly Member[]
): Member | undefined {
    return members.find((member) => member === value);
}
