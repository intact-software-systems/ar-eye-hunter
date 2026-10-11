export function arrayEquals<T>(left: readonly T[], right: readonly T[]): boolean {
    return (
        left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
    );
}

export function jsonEquals(left: unknown, right: unknown): boolean {
    return JSON.stringify(toOrderedJson(left, 'content')) === JSON.stringify(toOrderedJson(right, 'content'));
}

export function stableJsonStringify(value: unknown): string {
    return JSON.stringify(toStableJson(value));
}

export function toStableJson(value: unknown): unknown {
    // ALM prepared fingerprints persist this ordering, including collation ties.
    return toOrderedJson(value, 'persisted');
}

export function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

function toOrderedJson(value: unknown, keyOrder: 'content' | 'persisted'): unknown {
    if (Array.isArray(value)) {
        return value.map((entryValue) => toOrderedJson(entryValue, keyOrder));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => {
                if (keyOrder === 'persisted') {
                    return left.localeCompare(right);
                }
                return left < right ? -1 : left > right ? 1 : 0;
            })
            .map(([key, entryValue]) => [key, toOrderedJson(entryValue, keyOrder)])
    );
}
