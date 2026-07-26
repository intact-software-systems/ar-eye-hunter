export type JsonWireValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonWireValue[]
    | JsonWireObject;

export type JsonWireObject = Readonly<{
    readonly [key: string]: JsonWireValue;
}>;

export async function hashMutationCommand(
    command: JsonWireValue,
): Promise<string> {
    assertJsonWireValue(command, 'Mutation command');
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(serializeCanonicalMutationCommand(command)),
    );
    const hex = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    return `sha256:${hex}`;
}

export function serializeCanonicalMutationCommand(
    command: JsonWireValue,
): string {
    return serializeCanonicalJson(command);
}

function assertJsonWireValue(value: unknown, label: string): void {
    let issue: string | undefined;
    try {
        issue = findJsonSafetyIssue(value, '$', new Set<object>());
    } catch {
        issue = 'value could not be inspected without executing custom behavior';
    }
    if (issue) throw new TypeError(`${label} must be JSON-safe: ${issue}`);
}

function findJsonSafetyIssue(
    value: unknown,
    path: string,
    activeObjects: Set<object>,
): string | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return undefined;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return `${path} contains a non-finite number`;
        if (Object.is(value, -0)) return `${path} contains negative zero`;
        return undefined;
    }
    if (typeof value !== 'object') return `${path} contains unsupported ${typeof value}`;
    if (activeObjects.has(value)) return `${path} contains a cycle`;

    activeObjects.add(value);
    const issue = Array.isArray(value)
        ? findJsonArraySafetyIssue(value, path, activeObjects)
        : findJsonObjectSafetyIssue(value, path, activeObjects);
    activeObjects.delete(value);
    return issue;
}

function findJsonArraySafetyIssue(
    value: readonly unknown[],
    path: string,
    activeObjects: Set<object>,
): string | undefined {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
        return `${path} uses a non-standard array prototype`;
    }
    const entryKeys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key === 'symbol') return `${path} contains a symbol key`;
        if (!isCanonicalArrayIndex(key, value.length)) {
            return `${path} contains non-index array property ${JSON.stringify(key)}`;
        }
        entryKeys.push(key);
    }
    if (entryKeys.length !== value.length) return `${path} contains a sparse array`;
    for (const key of entryKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable) {
            return `${path}[${key}] is not an enumerable data property`;
        }
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            return `${path}[${key}] is an accessor property`;
        }
        const issue = findJsonSafetyIssue(
            descriptor.value,
            `${path}[${key}]`,
            activeObjects,
        );
        if (issue) return issue;
    }
    return undefined;
}

function findJsonObjectSafetyIssue(
    value: object,
    path: string,
    activeObjects: Set<object>,
): string | undefined {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return `${path} uses a non-plain object`;
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') return `${path} contains a symbol key`;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const propertyPath = `${path}.${key}`;
        if (!descriptor || !descriptor.enumerable) {
            return `${propertyPath} is not an enumerable data property`;
        }
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            return `${propertyPath} is an accessor property`;
        }
        const issue = findJsonSafetyIssue(
            descriptor.value,
            propertyPath,
            activeObjects,
        );
        if (issue) return issue;
    }
    return undefined;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
    if (!/^(0|[1-9]\d*)$/.test(key)) return false;
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function serializeCanonicalJson(value: JsonWireValue): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) as string;
    }
    if (Array.isArray(value)) {
        return `[${value.map(serializeCanonicalJson).join(',')}]`;
    }
    const record = value as JsonWireObject;
    return `{${Object.keys(record)
        .sort(compareJsonKeys)
        .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(record[key]!)}`)
        .join(',')}}`;
}

function compareJsonKeys(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
