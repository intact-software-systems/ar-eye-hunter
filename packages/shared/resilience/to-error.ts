/** Normalize a caught value before it leaves an exception boundary. */
export function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
