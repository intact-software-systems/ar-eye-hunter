import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

/** Own JSON comparison trees while retaining invalid non-JSON values for their existing validation boundary. */
export function snapshotComparisonValue<Operand>(value: Operand, copies = new WeakMap<object, object>()): Operand {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    const copied = copies.get(value);
    if (copied) {
        return copied as Operand;
    }
    if (Array.isArray(value)) {
        const array: unknown[] = [];
        copies.set(value, array);
        for (const item of value) {
            array.push(snapshotComparisonValue(item, copies));
        }
        return Object.freeze(array) as Operand;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        return value;
    }
    const record: RallarBlackBoxTestRecord = {};
    copies.set(value, record);
    for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(record, key, { value: snapshotComparisonValue(item, copies), enumerable: true });
    }
    return Object.freeze(record) as Operand;
}
