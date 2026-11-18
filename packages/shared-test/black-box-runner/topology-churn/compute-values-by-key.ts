export function computeValuesByKey<Key extends string, Value>(
    keys: readonly Key[],
    valueOf: (key: Key) => Value
): Record<Key, Value> {
    return Object.fromEntries(keys.map((key) => [key, valueOf(key)])) as Record<Key, Value>;
}
