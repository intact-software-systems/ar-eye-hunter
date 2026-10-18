import { toError } from './to-error.ts';

/** Drains every operation before returning, retaining failures in observed rejection order. */
export async function settleAll<T>(operations: readonly Promise<T>[]): Promise<T[]> {
    const failures: PromiseRejectedResult[] = [];
    const observed = operations.map((operation) =>
        operation.catch((reason) => {
            if (!failures.some((failure) => Object.is(failure.reason, reason))) {
                failures.push({ status: 'rejected', reason });
            }
            throw reason;
        })
    );
    const settled = await Promise.allSettled(observed);
    if (failures.length === 1) {
        throw failures[0].reason;
    }
    if (failures.length > 1) {
        throw new AggregateError(failures.map((failure) => failure.reason), toSettlementFailureMessage(failures[0]), {
            cause: failures[0].reason
        });
    }
    return settled.map((result) => {
        if (result.status === 'rejected') {
            throw result.reason;
        }
        return result.value;
    });
}
function toSettlementFailureMessage(failure: PromiseRejectedResult): string {
    try {
        const message = toError(failure.reason).message;
        return typeof message === 'string' ? message : 'Multiple operations failed';
    }
    catch {
        return 'Multiple operations failed';
    }
}
