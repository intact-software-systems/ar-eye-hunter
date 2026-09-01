// deno-lint-ignore-file no-explicit-any
export interface Redaction {
    name: string;
    value: string;
}

export function isRecord(value: any): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function addRedaction(redactions: Redaction[], name: string, value: any): void {
    if (value === undefined || value === null) {
        return;
    }

    const text = String(value);
    if (text.length <= 0) {
        return;
    }

    if (redactions.some((redaction) => redaction.name === name && redaction.value === text)) {
        return;
    }

    redactions.push({
        name,
        value: text
    });
}

export function normalizeRedactions(redactions: any): Redaction[] {
    if (Array.isArray(redactions)) {
        return redactions.flatMap((redaction) => {
            if (isRecord(redaction) && typeof redaction.value === 'string' && redaction.value.length > 0) {
                return [{
                    name: typeof redaction.name === 'string' && redaction.name.length > 0
                        ? redaction.name
                        : 'secret',
                    value: redaction.value
                }];
            }

            return [];
        });
    }

    if (isRecord(redactions)) {
        return Object.entries(redactions).flatMap(([name, value]) => {
            if (value === undefined || value === null || String(value).length <= 0) {
                return [];
            }

            return [{
                name,
                value: String(value)
            }];
        });
    }

    return [];
}

function redactString(value: string, redactions: Redaction[]): string {
    return redactions.reduce((text, redaction) => {
        return redaction.value.length > 0
            ? text.replaceAll(redaction.value, `<redacted:${redaction.name}>`)
            : text;
    }, value);
}

export function redactBlackBoxData<T>(value: T, redactions: Redaction[] = []): T {
    if (redactions.length <= 0) {
        return value;
    }

    if (typeof value === 'string') {
        return redactString(value, redactions) as T;
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactBlackBoxData(item, redactions)) as T;
    }

    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, redactBlackBoxData(nested, redactions)])
        ) as T;
    }

    return value;
}
