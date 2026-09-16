import { uniqueSortedValues } from '../distributed/unique-sorted-values.ts';

export function compactStrings(values: readonly (string | undefined)[]): readonly string[] {
    return uniqueSortedValues(values.filter((value): value is string => Boolean(value && value.length > 0)));
}
