export function parseEvidenceJson(value: string | null): unknown {
    if (!value) return undefined
    try {
        return JSON.parse(value)
    } catch {
        return undefined
    }
}

export function nestedEvidenceJson(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const parsed = parseEvidenceJson(value)
    return parsed === undefined ? value : parsed
}

export function collectEvidenceNamedStrings(
    value: unknown,
    names: ReadonlySet<string>,
    into: Set<string>,
): void {
    const candidate = nestedEvidenceJson(value)
    if (!candidate || typeof candidate !== 'object') return
    if (Array.isArray(candidate)) {
        candidate.forEach((item) => collectEvidenceNamedStrings(item, names, into))
        return
    }
    for (const [key, child] of Object.entries(candidate)) {
        if (names.has(key) && typeof child === 'string') into.add(child)
        if (names.has(key) && Array.isArray(child)) {
            child.filter((item): item is string => typeof item === 'string')
                .forEach((item) => into.add(item))
        }
        collectEvidenceNamedStrings(child, names, into)
    }
}
