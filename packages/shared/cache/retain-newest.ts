export interface RetainNewestResult<T> {
    readonly retained: readonly T[];
    readonly displaced: readonly T[];
}

/** `values` oldest first; keeps the newest `limit`, and `displaced` is what fell off, oldest first. */
export function retainNewest<T>(values: readonly T[], limit: number): RetainNewestResult<T> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('limit must be a positive safe integer');
    }
    const displacedCount = Math.max(0, values.length - limit);
    return { retained: values.slice(displacedCount), displaced: values.slice(0, displacedCount) };
}
