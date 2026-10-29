export interface ComputeALPublicationRetentionInput<T> {
    /** The stream's staged values, oldest first. */
    readonly retained: readonly T[];
    readonly incoming: T;
    readonly retainNewest: number;
}

export interface ALPublicationRetention<T> {
    readonly retained: readonly T[];
    /** The oldest value the incoming one pushed past `retainNewest`; the caller settles it `superseded`. */
    readonly displaced: T | undefined;
}

export function computeALPublicationRetention<T>(
    input: ComputeALPublicationRetentionInput<T>
): ALPublicationRetention<T> {
    const candidates = [...input.retained, input.incoming];
    if (candidates.length <= input.retainNewest) {
        return { retained: candidates, displaced: undefined };
    }
    return { retained: candidates.slice(1), displaced: candidates[0] };
}
