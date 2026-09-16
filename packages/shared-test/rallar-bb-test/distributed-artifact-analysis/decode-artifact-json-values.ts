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

/** The array items the decoder reads, skipping the ones it cannot; none when the value is not an array. */
export function decodeRecordItems<Item>(
    value: unknown,
    decodeItem: (item: unknown) => Item | undefined
): readonly Item[] {
    return Array.isArray(value)
        ? value.flatMap((item) => {
            const decoded = decodeItem(item);
            return decoded === undefined ? [] : [decoded];
        })
        : [];
}
