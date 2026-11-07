/** Asserts `condition` with the `asserts` narrowing that `expect(...).toBeTruthy()` cannot provide. */
export function assert(condition: unknown, message?: string): asserts condition {
    if (!condition) {
        throw new Error(message ?? 'Assertion failed.');
    }
}
