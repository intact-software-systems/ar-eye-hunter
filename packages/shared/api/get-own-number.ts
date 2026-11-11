/**
 * An own data property's number along `path`, never invoking an accessor: a field absent anywhere on the path (or `undefined`) reads
 * `absent`; a present value of another type, or a parent that is not a plain object, reads NaN, which a positive-integer check reports.
 */
export function getOwnNumber(source: object, path: readonly string[], absent: number): number {
    const [field, ...deeperPath] = path;
    if (field === undefined) {
        return Number.NaN;
    }
    const value = Object.getOwnPropertyDescriptor(source, field)?.value;
    if (value === undefined) {
        return absent;
    }
    if (deeperPath.length === 0) {
        return typeof value === 'number' ? value : Number.NaN;
    }
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? getOwnNumber(value, deeperPath, absent)
        : Number.NaN;
}
