import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { isFiniteNumber, isNonEmptyText } from './artifact-json-value-guards.ts';

/** Absent when the value is not a non-empty string. */
export function decodeText(value: unknown): string | undefined {
    return isNonEmptyText(value) ? value : undefined;
}

/** Absent when the value is not a finite number. */
export function decodeNumber(value: unknown): number | undefined {
    return isFiniteNumber(value) ? value : undefined;
}

/** Absent when the value is not a boolean. */
export function decodeBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

/** Absent unless both times are finite numbers and the end is not before the start. */
export function decodeElapsedMs(start: unknown, end: unknown): number | undefined {
    return isFiniteNumber(start) && isFiniteNumber(end) && end >= start ? end - start : undefined;
}

/** The non-empty strings of an array, or none when the value is not an array. */
export function decodeTexts(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter(isNonEmptyText) : [];
}

/** The finite-number entries of a JSON object, ordered by key, or none when the value is not an object. */
export function decodeNumberRecord(value: unknown): Readonly<Record<string, number>> {
    if (!isJsonRecordValue(value)) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(value)
            .filter((entry): entry is [string, number] => isFiniteNumber(entry[1]))
            .sort(([left], [right]) => left.localeCompare(right))
    );
}

/** An array's items, each item that is not a JSON object read as an empty object; none when the value is not an array. */
export function decodeRecordItems<Item>(
    value: unknown,
    decodeItem: (item: unknown) => Item
): readonly Item[] {
    return Array.isArray(value) ? value.map((item) => decodeItem(isJsonRecordValue(item) ? item : {})) : [];
}
