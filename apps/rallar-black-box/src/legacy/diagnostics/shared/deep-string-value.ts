export function findStringDeep(
    value: unknown,
    keys: readonly string[],
    depth = 0
): string | undefined {
    if (depth > 4 || value === undefined || value === null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findStringDeep(item, keys, depth + 1);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
    if (typeof value !== 'object') {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate;
        }
    }
    for (const child of Object.values(record)) {
        const found = findStringDeep(child, keys, depth + 1);
        if (found) {
            return found;
        }
    }
    return undefined;
}
