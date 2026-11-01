import { ApiHttpError } from './http-error.ts';

/** A terminal mutation outcome allows a new intent; transport ambiguity must retain the original request ID. */
export function isDefinitiveApiMutationFailure(error: Error): boolean {
    return error instanceof ApiHttpError && (error.mutationFailure?.retry?.kind === 'exhausted' ||
        (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429));
}
