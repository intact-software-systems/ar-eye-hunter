export function computeCountsByKey<Key extends string>(
    keys: readonly Key[],
    countKey: (key: Key) => number
): Record<Key, number> {
    return Object.fromEntries(keys.map((key) => [key, countKey(key)])) as Record<Key, number>;
}
