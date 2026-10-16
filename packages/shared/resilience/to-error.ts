/** Normalize a caught value before it leaves an exception boundary. */
export function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

/**
 * An error chain as data: names, messages and own enumerable properties, never stack frames. An error held in a
 * property is summarized the same way; one already summarized in the chain keeps only its name and message.
 */
export interface ErrorSummary {
    readonly name: string;
    readonly message: string;
    readonly properties: Readonly<Record<string, unknown>>;
    readonly cause: ErrorSummary | null;
}

export function toErrorSummary(error: Error): ErrorSummary {
    return toErrorSummaryAbove(error, new Set());
}

function toErrorSummaryAbove(error: Error, seen: Set<Error>): ErrorSummary {
    if (seen.has(error)) {
        return { name: error.name, message: error.message, properties: {}, cause: null };
    }
    seen.add(error);
    const properties = Object.fromEntries(
        Object.entries(error)
            .filter(([property]) => !ERROR_OWN_FIELDS.has(property))
            .map(([property, value]) => [property, value instanceof Error ? toErrorSummaryAbove(value, seen) : value])
    );
    const cause = error.cause instanceof Error && !seen.has(error.cause)
        ? toErrorSummaryAbove(error.cause, seen)
        : null;
    return { name: error.name, message: error.message, properties, cause };
}

const ERROR_OWN_FIELDS: ReadonlySet<string> = new Set(['name', 'message', 'stack', 'cause']);
