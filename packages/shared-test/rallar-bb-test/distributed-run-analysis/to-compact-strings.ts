import { toUniqueSortedValues } from '../distributed/to-unique-sorted-values.ts';

export function toCompactStrings(values: readonly (string | undefined)[]): readonly string[] {
    return toUniqueSortedValues(values.filter((value): value is string => Boolean(value && value.length > 0)));
}
