/** Any value JSON.stringify accepts, before its toJSON, omission and non-finite conversions. */
export type JsonSerializableValue = string | number | boolean | bigint | symbol | object | null | undefined;

export type JsonSerializableRecord = Readonly<Record<string, JsonSerializableValue>>;

export type PlainJsonComparison = 'equal' | 'different' | 'not-plain';

/** Decides plain JSON trees by structure; anything JSON would convert is left to the serialized comparison. */
export function comparePlainJson(left: JsonSerializableValue, right: JsonSerializableValue): PlainJsonComparison {
    const leftKind = toPlainJsonKind(left);
    const rightKind = toPlainJsonKind(right);
    if (leftKind === 'not-plain' || rightKind === 'not-plain') {
        return 'not-plain';
    }
    if (leftKind !== rightKind) {
        return 'different';
    }
    if (leftKind === 'array') {
        return comparePlainJsonArrays(
            left as readonly JsonSerializableValue[],
            right as readonly JsonSerializableValue[]
        );
    }
    if (leftKind === 'object') {
        return comparePlainJsonObjects(left as JsonSerializableRecord, right as JsonSerializableRecord);
    }
    return left === right ? 'equal' : 'different';
}

function toPlainJsonKind(value: JsonSerializableValue): 'leaf' | 'array' | 'object' | 'not-plain' {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return 'leaf';
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? 'leaf' : 'not-plain';
    }
    if (typeof value !== 'object' || 'toJSON' in value) {
        return 'not-plain';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? 'object' : 'not-plain';
}

function comparePlainJsonArrays(
    left: readonly JsonSerializableValue[],
    right: readonly JsonSerializableValue[]
): PlainJsonComparison {
    if (left.length !== right.length) {
        return 'different';
    }
    for (let index = 0; index < left.length; index += 1) {
        const entry = comparePlainJson(left[index], right[index]);
        if (entry !== 'equal') {
            return entry;
        }
    }
    return 'equal';
}

function comparePlainJsonObjects(
    left: JsonSerializableRecord,
    right: JsonSerializableRecord
): PlainJsonComparison {
    let leftCount = 0;
    for (const key of Object.keys(left)) {
        if (left[key] === undefined) {
            continue;
        }
        leftCount += 1;
        const entry = right[key] === undefined || !Object.hasOwn(right, key)
            ? toMissingPlainJsonComparison(left[key])
            : comparePlainJson(left[key], right[key]);
        if (entry !== 'equal') {
            return entry;
        }
    }
    let rightCount = 0;
    for (const key of Object.keys(right)) {
        if (right[key] === undefined) {
            continue;
        }
        if (toPlainJsonKind(right[key]) === 'not-plain') {
            return 'not-plain';
        }
        rightCount += 1;
    }
    return leftCount === rightCount ? 'equal' : 'different';
}

function toMissingPlainJsonComparison(present: JsonSerializableValue): PlainJsonComparison {
    return toPlainJsonKind(present) === 'not-plain' ? 'not-plain' : 'different';
}
