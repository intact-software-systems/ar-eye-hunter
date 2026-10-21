import { toError } from './to-error.ts';

/**
 * Drains every operation before returning. A failure rejects with one error, never an aggregate: the first in input
 * order that `isPreferred` selects, otherwise the first in input order.
 */
export async function settleAllInOrder<T>(
    operations: readonly Promise<T>[],
    isPreferred: (failure: Error) => boolean
): Promise<T[]> {
    const settled = await Promise.allSettled(operations);
    const failures = settled.flatMap((result) => (result.status === 'rejected' ? [toError(result.reason)] : []));
    const failure = failures.find(isPreferred) ?? failures[0];
    if (failure !== undefined) {
        throw failure;
    }
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}
