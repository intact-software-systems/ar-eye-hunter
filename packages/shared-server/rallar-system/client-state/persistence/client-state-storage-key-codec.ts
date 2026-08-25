export function encodeClientStateStorageKeyPart(value: string): string {
    return encodeURIComponent(value);
}

export function decodeClientStateStorageKey(
    key: string,
    names: readonly string[]
): readonly string[] {
    const segments = key.split(':');
    if (segments.length !== names.length) {
        throw new TypeError('Stored client-state key is not canonical');
    }
    return names.map((name, index) => {
        const prefix = `${name}=`;
        const segment = segments[index];
        if (!segment?.startsWith(prefix)) {
            throw new TypeError('Stored client-state key is not canonical');
        }
        const encoded = segment.slice(prefix.length);
        const decoded = decodeURIComponent(encoded);
        if (decoded.length === 0 || encodeClientStateStorageKeyPart(decoded) !== encoded) {
            throw new TypeError('Stored client-state key is not canonical');
        }
        return decoded;
    });
}

export function readDecodedClientStateStorageKeyPart(
    values: readonly string[],
    index: number
): string {
    const value = values[index];
    if (value === undefined) {
        throw new TypeError('Stored client-state key is not canonical');
    }
    return value;
}

export function compareClientStateStorageKeys(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}
