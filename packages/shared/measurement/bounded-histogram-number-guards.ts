/** What a histogram records, and what it accepts as a bound. */
export function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isWholeCount(value: unknown): value is number {
    return isFiniteNonNegative(value) && Number.isSafeInteger(value);
}
