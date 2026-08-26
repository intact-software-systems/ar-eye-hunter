export type CanonicalJsonInput = null | boolean | number | string | object;

interface CanonicalJsonObjectEntry {
    readonly key: string;
    readonly value: CanonicalJsonInput;
}

export async function sha256CanonicalJson(value: CanonicalJsonInput): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(serializeCanonicalJson(value))
    );
    return bytesToHex(new Uint8Array(digest));
}

export function serializeCanonicalJson(value: CanonicalJsonInput): string {
    return serializeCanonicalJsonValue(value, new Set<object>());
}

function serializeCanonicalJsonValue(
    value: CanonicalJsonInput | undefined,
    activeObjects: Set<object>
): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Canonical JSON number must be finite');
        }
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (value === undefined) {
        throw new TypeError('Canonical JSON array entries must be defined');
    }
    if (isCanonicalJsonArray(value)) {
        assertCanonicalJsonArray(value);
        return withActiveObject(
            activeObjects,
            value,
            () => `[${value.map((entry) => serializeCanonicalJsonValue(entry, activeObjects)).join(',')}]`
        );
    }

    assertCanonicalJsonObject(value);
    return withActiveObject(activeObjects, value, () =>
        `{${
            readCanonicalJsonObjectEntries(value)
                .sort((left, right) => compareCanonicalJsonKeys(left.key, right.key))
                .map((entry) =>
                    `${JSON.stringify(entry.key)}:${serializeCanonicalJsonValue(entry.value, activeObjects)}`
                )
                .join(',')
        }}`);
}

function isCanonicalJsonArray(value: CanonicalJsonInput): value is readonly CanonicalJsonInput[] {
    return Array.isArray(value);
}

function assertCanonicalJsonArray(value: readonly CanonicalJsonInput[]): void {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Canonical JSON array must use the standard prototype');
    }
    for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') {
            continue;
        }
        if (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)) {
            throw new TypeError('Canonical JSON array must only contain indexed entries');
        }
    }
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
            throw new TypeError('Canonical JSON array must be dense');
        }
        if (
            !descriptor.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ) {
            throw new TypeError('Canonical JSON array entries must be enumerable data properties');
        }
    }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
        return false;
    }
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function assertCanonicalJsonObject(value: object): void {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Canonical JSON object must use a plain prototype');
    }
}

function readCanonicalJsonObjectEntries(value: object): CanonicalJsonObjectEntry[] {
    const entries: CanonicalJsonObjectEntry[] = [];
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
            throw new TypeError('Canonical JSON object must not contain symbol keys');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
            !descriptor ||
            !descriptor.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ) {
            throw new TypeError('Canonical JSON object properties must be enumerable data properties');
        }
        const entry = decodeCanonicalJsonObjectEntry(descriptor);
        if (entry === undefined) {
            continue;
        }
        entries.push({ key, value: entry });
    }
    return entries;
}

function decodeCanonicalJsonObjectEntry(
    descriptor: PropertyDescriptor
): CanonicalJsonInput | undefined {
    const value = descriptor.value;
    if (value === undefined) {
        return undefined;
    }
    if (
        value === null ||
        typeof value === 'boolean' ||
        typeof value === 'number' ||
        typeof value === 'string' ||
        typeof value === 'object'
    ) {
        return value;
    }
    throw new TypeError('Canonical JSON object contains an unsupported value');
}

function withActiveObject<Result>(
    activeObjects: Set<object>,
    value: object,
    serialize: () => Result
): Result {
    if (activeObjects.has(value)) {
        throw new TypeError('Canonical JSON value must not contain cycles');
    }
    activeObjects.add(value);
    try {
        return serialize();
    }
    finally {
        activeObjects.delete(value);
    }
}

function compareCanonicalJsonKeys(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}
