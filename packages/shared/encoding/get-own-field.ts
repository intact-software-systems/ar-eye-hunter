/** An own data property's value, never invoking an accessor; absent and inherited fields read `undefined`. */
export function getOwnField(record: object, key: string) {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

/** An own data property that is a non-negative safe integer, else null. */
export function getOwnCount(record: object, key: string): number | null {
    const count = getOwnField(record, key);
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}
