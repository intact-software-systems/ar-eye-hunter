/** A JSON tree that serializes as itself; an undefined record value is an absent key. */
export type PlainJsonValue = string | number | boolean | null | readonly PlainJsonValue[] | PlainJsonRecord;

export interface PlainJsonRecord {
    readonly [key: string]: PlainJsonValue | undefined;
}

/** Plain JSON only: no toJSON, no value JSON would omit or convert, no prototype but Object's or none. */
export function isPlainJsonValue(value: unknown): value is PlainJsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (typeof value !== 'object' || 'toJSON' in value) {
        return false;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (!isPlainJsonValue(value[index])) {
                return false;
            }
        }
        return true;
    }
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
        Object.values(value).every((entry) => entry === undefined || isPlainJsonValue(entry));
}

/** Equal modulo key order, which is what equal serializations of two plain JSON trees mean. */
export function arePlainJsonValuesEqual(left: PlainJsonValue, right: PlainJsonValue): boolean {
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return left === right;
    }
    if (isPlainJsonArray(left) || isPlainJsonArray(right)) {
        return isPlainJsonArray(left) && isPlainJsonArray(right) && arePlainJsonArraysEqual(left, right);
    }
    return arePlainJsonRecordsEqual(left, right);
}

function isPlainJsonArray(value: PlainJsonValue): value is readonly PlainJsonValue[] {
    return Array.isArray(value);
}

function arePlainJsonArraysEqual(left: readonly PlainJsonValue[], right: readonly PlainJsonValue[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (!arePlainJsonValuesEqual(left[index], right[index])) {
            return false;
        }
    }
    return true;
}

function arePlainJsonRecordsEqual(left: PlainJsonRecord, right: PlainJsonRecord): boolean {
    let leftCount = 0;
    for (const key of Object.keys(left)) {
        const value = left[key];
        if (value === undefined) {
            continue;
        }
        leftCount += 1;
        const other = Object.hasOwn(right, key) ? right[key] : undefined;
        if (other === undefined || !arePlainJsonValuesEqual(value, other)) {
            return false;
        }
    }
    return leftCount === countPresentKeys(right);
}

function countPresentKeys(record: PlainJsonRecord): number {
    let count = 0;
    for (const key of Object.keys(record)) {
        if (record[key] !== undefined) {
            count += 1;
        }
    }
    return count;
}
