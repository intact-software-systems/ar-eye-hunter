import { computeSha256CanonicalJson, serializeCanonicalJson } from './canonical-json.ts';

export type JsonWireValue = null | boolean | number | string | readonly JsonWireValue[] | JsonWireObject;

export type JsonWireObject = Readonly<{
    readonly [key: string]: JsonWireValue;
}>;

interface InspectedJsonArray {
    readonly length: number;
}

/** One traversal's state: the objects on the current path, for cycle detection, and the first issue found. */
interface JsonSafetyInspection {
    readonly activeObjects: Set<object>;
    readonly issues: string[];
}

export function decodeJsonWireValue(value: unknown, label = 'JSON wire value'): JsonWireValue {
    const inspection: JsonSafetyInspection = { activeObjects: new Set<object>(), issues: [] };
    if (isInspectedJsonWireValue(value, inspection)) {
        return value;
    }
    throw new TypeError(`${label} must be JSON-safe: ${inspection.issues[0]}`);
}

export function decodeJsonWireText(serialized: string, label = 'JSON wire value'): JsonWireValue {
    return decodeJsonWireValue(JSON.parse(serialized), label);
}

export function encodeJsonWireValue<Value>(value: Value, label = 'JSON wire value'): JsonWireValue {
    return decodeJsonWireValue(value, label);
}

export function computeMutationCommandDigest(command: JsonWireValue): string {
    return `sha256:${computeSha256CanonicalJson(command)}`;
}

export function serializeCanonicalMutationCommand(command: JsonWireValue): string {
    return serializeCanonicalJson(command);
}

function isInspectedJsonWireValue(value: unknown, inspection: JsonSafetyInspection): value is JsonWireValue {
    try {
        return isJsonSafeValue(value, '$', inspection);
    }
    catch {
        inspection.issues.push('value could not be inspected without executing custom behavior');
        return false;
    }
}

function isJsonSafeValue(value: unknown, path: string, inspection: JsonSafetyInspection): value is JsonWireValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return rejectJsonSafety(inspection, `${path} contains a non-finite number`);
        }
        if (Object.is(value, -0)) {
            return rejectJsonSafety(inspection, `${path} contains negative zero`);
        }
        return true;
    }
    if (typeof value !== 'object') {
        return rejectJsonSafety(inspection, `${path} contains unsupported ${typeof value}`);
    }
    if (inspection.activeObjects.has(value)) {
        return rejectJsonSafety(inspection, `${path} contains a cycle`);
    }

    inspection.activeObjects.add(value);
    const safe = Array.isArray(value)
        ? isJsonSafeArray(value, path, inspection)
        : isJsonSafeObject(value, path, inspection);
    inspection.activeObjects.delete(value);
    return safe;
}

function isJsonSafeArray(value: InspectedJsonArray, path: string, inspection: JsonSafetyInspection): boolean {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
        return rejectJsonSafety(inspection, `${path} uses a non-standard array prototype`);
    }
    const entryKeys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') {
            continue;
        }
        if (typeof key === 'symbol') {
            return rejectJsonSafety(inspection, `${path} contains a symbol key`);
        }
        if (!isCanonicalArrayIndex(key, value.length)) {
            return rejectJsonSafety(inspection, `${path} contains non-index array property ${JSON.stringify(key)}`);
        }
        entryKeys.push(key);
    }
    if (entryKeys.length !== value.length) {
        return rejectJsonSafety(inspection, `${path} contains a sparse array`);
    }
    for (const key of entryKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable) {
            return rejectJsonSafety(inspection, `${path}[${key}] is not an enumerable data property`);
        }
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            return rejectJsonSafety(inspection, `${path}[${key}] is an accessor property`);
        }
        if (!isJsonSafeValue(descriptor.value, `${path}[${key}]`, inspection)) {
            return false;
        }
    }
    return true;
}

function isJsonSafeObject(value: object, path: string, inspection: JsonSafetyInspection): boolean {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return rejectJsonSafety(inspection, `${path} uses a non-plain object`);
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
            return rejectJsonSafety(inspection, `${path} contains a symbol key`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const propertyPath = `${path}.${key}`;
        if (!descriptor || !descriptor.enumerable) {
            return rejectJsonSafety(inspection, `${propertyPath} is not an enumerable data property`);
        }
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            return rejectJsonSafety(inspection, `${propertyPath} is an accessor property`);
        }
        if (!isJsonSafeValue(descriptor.value, propertyPath, inspection)) {
            return false;
        }
    }
    return true;
}

function rejectJsonSafety(inspection: JsonSafetyInspection, issue: string): false {
    inspection.issues.push(issue);
    return false;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
        return false;
    }
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length;
}
