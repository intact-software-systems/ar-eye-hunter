export function uniqueValues<T extends string>(
    values: readonly (T | undefined)[],
): readonly T[] {
    return [
        ...new Set(values.filter((value): value is T => Boolean(value))),
    ].sort();
}
