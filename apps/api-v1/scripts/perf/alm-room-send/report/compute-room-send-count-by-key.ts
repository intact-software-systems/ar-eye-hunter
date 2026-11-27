/**
 * How often each key occurs, on top of `countOfNoKeys`: the keys the caller names in advance, each at 0, or none. A
 * key is counted under a property of the result's own, whatever every object inherits under that name.
 */
export function computeRoomSendCountByKey<Key extends string>(
    keys: readonly Key[],
    countOfNoKeys: Readonly<Record<Key, number>>
): Readonly<Record<Key, number>> {
    return keys.reduce<Readonly<Record<Key, number>>>(
        (counts, key) => ({ ...counts, [key]: (Object.hasOwn(counts, key) ? counts[key] : 0) + 1 }),
        countOfNoKeys
    );
}
