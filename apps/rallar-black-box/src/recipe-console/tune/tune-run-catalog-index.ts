export function indexTuneRows<T>(
    values: readonly T[],
    key: (value: T) => string,
    onRow: () => void,
): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const value of values) {
        onRow();
        const identity = key(value);
        const group = groups.get(identity);
        if (group) group.push(value);
        else groups.set(identity, [value]);
    }
    return groups;
}

export function boundedTunePerformanceRunIds(
    values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
    if (values === undefined) return undefined;
    const ids = new Set<string>();
    for (const value of values) {
        ids.add(value);
        if (ids.size === 2) break;
    }
    return ids;
}
