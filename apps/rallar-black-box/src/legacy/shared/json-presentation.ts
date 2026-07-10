export function json(value: unknown): string {
    return JSON.stringify(value ?? null, null, 2);
}

export function parseJsonText(text: string, fallback: unknown = {}): unknown {
    const trimmed = text.trim();
    return trimmed.length > 0 ? (JSON.parse(trimmed) as unknown) : fallback;
}

export function splitCsvValues(value: string): readonly string[] {
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}
