/**
 * An own data property's number along `path`, never invoking an accessor: a field absent anywhere on the path (or `undefined`) reads
 * `absent`; a present value of another type, or a parent that is not a plain object, reads NaN, which a positive-integer check reports.
 */
export function getOwnNumber(source: object, path: readonly string[], absent: number): number {
    let current: unknown = source;
    for (const field of path) {
        if (typeof current !== 'object' || current === null || Array.isArray(current)) {
            return Number.NaN;
        }
        current = Object.getOwnPropertyDescriptor(current, field)?.value;
        if (current === undefined) {
            return absent;
        }
    }
    return typeof current === 'number' ? current : Number.NaN;
}
