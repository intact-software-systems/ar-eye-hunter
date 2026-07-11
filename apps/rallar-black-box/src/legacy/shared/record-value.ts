export function recordArray(value: unknown): readonly Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.filter(
            (item): item is Record<string, unknown> =>
                Boolean(item) &&
                typeof item === 'object' &&
                !Array.isArray(item),
        );
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return [value as Record<string, unknown>];
    }

    return [];
}

export function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
