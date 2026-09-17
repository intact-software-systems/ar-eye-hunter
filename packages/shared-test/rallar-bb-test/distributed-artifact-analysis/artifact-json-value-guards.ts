import { Either } from '@shared/resilience/Either.ts';

import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

export function isNonEmptyText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function isTextArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isAbsentOrNonEmptyText(value: unknown): value is string | undefined {
    return value === undefined || isNonEmptyText(value);
}

export function isAbsentOrFiniteNumber(value: unknown): value is number | undefined {
    return value === undefined || isFiniteNumber(value);
}

export function isAbsentOrBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === 'boolean';
}

export function isFiniteNumberRecord(value: unknown): value is Readonly<Record<string, number>> {
    return isJsonRecordValue(value) && Object.values(value).every(isFiniteNumber);
}

export function isOneOf<Member extends string>(
    value: unknown,
    members: readonly Member[]
): value is Member {
    return typeof value === 'string' && members.some((member) => member === value);
}

/** The members as prose alternatives: `a, b or c`. */
export function toAlternativesText(members: readonly string[]): string {
    return members.length <= 1
        ? members.join('')
        : `${members.slice(0, -1).join(', ')} or ${members[members.length - 1]}`;
}

export function decodeArrayItems<Item>(
    value: unknown,
    path: string,
    decodeItem: (item: unknown, itemPath: string) => Either<string, Item>
): Either<string, readonly Item[]> {
    if (!Array.isArray(value)) {
        return Either.ofLeft(`${path} must be an array`);
    }
    const items: Item[] = [];
    for (const [index, item] of value.entries()) {
        const decoded = decodeItem(item, `${path}[${index}]`);
        if (decoded.left !== undefined) {
            return Either.ofLeft(decoded.left);
        }
        items.push(decoded.right as Item);
    }
    return Either.ofRight(items);
}

export function toFirstDecodeIssue(
    checks: readonly (readonly [boolean, string])[]
): string | undefined {
    return checks.find(([valid]) => !valid)?.[1];
}
