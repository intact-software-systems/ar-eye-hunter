export function uniqueSortedValues<Value extends string>(
    values: readonly Value[]
): readonly Value[] {
    return [...new Set(values)].sort();
}
