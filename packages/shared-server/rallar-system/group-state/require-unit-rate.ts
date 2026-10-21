export function requireUnitRate(value: unknown, label: string): asserts value is number {
    if (
        typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) ||
        value < 0 || value > 1
    ) {
        throw new TypeError(`${label} must be within [0, 1]`);
    }
}
