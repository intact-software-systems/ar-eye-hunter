const documentTextByValue = new WeakMap<object, string>();

export function rememberControlResponseDocument(
    value: unknown,
    exactText: string,
): void {
    const key = weakKey(value);
    if (key) {
        documentTextByValue.set(key, exactText);
    }
}

export function inheritControlResponseDocument(
    from: unknown,
    to: unknown,
): void {
    const exactText = controlResponseDocumentText(from);
    if (exactText !== undefined) {
        rememberControlResponseDocument(to, exactText);
    }
}

export function controlResponseDocumentText(
    value: unknown,
): string | undefined {
    const key = weakKey(value);
    return key ? documentTextByValue.get(key) : undefined;
}

function weakKey(value: unknown): object | undefined {
    return value !== null &&
        (typeof value === 'object' || typeof value === 'function')
        ? (value as object)
        : undefined;
}
