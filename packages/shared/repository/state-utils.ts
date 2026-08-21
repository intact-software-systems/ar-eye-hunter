export function arrayEquals<T>(left: readonly T[], right: readonly T[]): boolean {
    return (
        left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
    );
}

export function jsonEquals(left: unknown, right: unknown): boolean {
    return stableJsonStringify(left) === stableJsonStringify(right);
}

export function stableJsonStringify(value: unknown): string {
    return JSON.stringify(toStableJson(value));
}

export function toStableJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(toStableJson);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, toStableJson(entryValue)])
    );
}

export function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}
