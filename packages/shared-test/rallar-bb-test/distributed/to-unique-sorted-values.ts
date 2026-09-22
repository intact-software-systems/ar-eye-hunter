export function toUniqueSortedValues<Value extends string>(
    values: readonly Value[]
): readonly Value[] {
    return [...new Set(values)].sort();
}
