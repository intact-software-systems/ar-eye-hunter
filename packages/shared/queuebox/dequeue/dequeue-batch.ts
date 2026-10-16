import { BoundedConcurrencyAdmission } from '../../resilience/bounded-concurrency-admission.ts';
import { Either, EitherCollectors } from '../../resilience/Either.ts';
import { toError } from '../../resilience/to-error.ts';
import { isNotReadyException } from '../resource-inbox/not-ready-exception.ts';
import type { DequeueController } from './dequeue-controller.ts';

interface DequeueBatchInput<K, V, T> {
    readonly entries: Map<K, V>;
    readonly computer: (key: K, value: V) => Promise<T>;
    readonly log: Pick<Console, 'error'>;
    readonly purpose: 'processing' | 'finalization-recovery';
    /** At most this many entries compute at once; the results keep the entries' order. */
    readonly maxConcurrentComputes: number;
    /**
     * Keys are colon-separated paths. An entry computes after every earlier entry whose key equals its own or is a
     * path prefix of it, or has its key as one: a scope-wide key orders against every key inside that scope. An
     * entry without a key is free.
     */
    readonly toExclusionKey: ((key: K, value: V) => string | undefined) | undefined;
}

type DequeueBatchEntryResult<K, V, T> = Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>;

interface DequeueBatchRelease<K, V, T> {
    readonly successReleaser: (
        entries: Map<K, DequeueController.Success<K, V, T>>
    ) => Promise<Map<K, DequeueController.Success<K, V, T>>>;
    readonly failureReleaser: (
        entries: Map<K, DequeueController.Failure<K, V>>
    ) => Promise<Map<K, DequeueController.Failure<K, V>>>;
    readonly onCompleted: ((entries: Map<K, DequeueController.Success<K, V, T>>) => void) | undefined;
    readonly onFailed: ((entries: Map<K, DequeueController.Failure<K, V>>) => void) | undefined;
}

export async function computeDequeueBatch<K, V, T>(
    { entries, computer, log, purpose, maxConcurrentComputes, toExclusionKey }: DequeueBatchInput<K, V, T>
): Promise<Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>> {
    const admission = new BoundedConcurrencyAdmission({ maxConcurrent: maxConcurrentComputes });
    const keyed: { readonly exclusionKey: string; readonly result: Promise<DequeueBatchEntryResult<K, V, T>>; }[] = [];
    const results = await Promise.all(
        [...entries].map(([key, value]) => {
            const exclusionKey = toExclusionKey?.(key, value);
            const previous = exclusionKey === undefined
                ? []
                : keyed.filter((earlier) => isOverlappingExclusionKey(earlier.exclusionKey, exclusionKey));
            // An entry waits for the entries it is ordered behind before it takes a slot, so a waiting one holds none.
            const result = Promise.all(previous.map((earlier) => earlier.result)).then(() =>
                admission.admit(() => computeDequeueEntry({ key, value, computer, log, purpose }))
            );
            if (exclusionKey !== undefined) {
                keyed.push({ exclusionKey, result });
            }
            return result;
        })
    );
    return new Map(results.map((result) => [result.fold((failure) => failure.key, (success) => success.key), result]));
}

function isOverlappingExclusionKey(left: string, right: string): boolean {
    return left === right || left.startsWith(`${right}:`) || right.startsWith(`${left}:`);
}

interface DequeueEntryInput<K, V, T> {
    readonly key: K;
    readonly value: V;
    readonly computer: (key: K, value: V) => Promise<T>;
    readonly log: Pick<Console, 'error'>;
    readonly purpose: DequeueBatchInput<K, V, T>['purpose'];
}

async function computeDequeueEntry<K, V, T>(
    { key, value, computer, log, purpose }: DequeueEntryInput<K, V, T>
): Promise<Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>> {
    try {
        return Either.ofRight({ key, value, computedValue: await computer(key, value) });
    }
    catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        if (purpose === 'finalization-recovery' || !isNotReadyException(exception)) {
            const operation = purpose === 'finalization-recovery' ? 'Finalization recovery' : 'Computer';
            log.error(`${operation} failed on dequeued key ${toDequeuedKeyText(key)}.`, exception);
        }
        return Either.ofLeft({ key, value, exception });
    }
}

/**
 * A success release that throws, such as one that lost a reservation after releasing the round's other rows, still
 * lets the round's failures release: its error is held as a value and rethrown once they are.
 */
export async function releaseDequeueBatch<K, V, T>(
    computed: Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>,
    release: DequeueBatchRelease<K, V, T>
): Promise<void> {
    const { rightByKey: successes, leftByKey: failures } = EitherCollectors.toMapFoldBoth(computed);
    const successFailure = successes.size === 0
        ? undefined
        : await releaseDequeueSuccesses(computed, successes, release);
    if (successFailure === undefined && (successes.size > 0 || failures.size === 0)) {
        release.onCompleted?.(EitherCollectors.toMapFoldRights(computed));
    }
    if (failures.size > 0) {
        const released = await release.failureReleaser(failures);
        for (const [key, result] of released) {
            computed.set(key, Either.ofLeft(result));
        }
        release.onFailed?.(EitherCollectors.toMapFoldLefts(computed));
    }
    if (successFailure !== undefined) {
        throw successFailure;
    }
}

async function releaseDequeueSuccesses<K, V, T>(
    computed: Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>,
    successes: Map<K, DequeueController.Success<K, V, T>>,
    release: DequeueBatchRelease<K, V, T>
): Promise<Error | undefined> {
    try {
        const released = await release.successReleaser(successes);
        for (const [key, result] of released) {
            computed.set(key, Either.ofRight(result));
        }
        return undefined;
    }
    catch (error) {
        return toError(error);
    }
}

export function toDequeuedKeyText<K>(key: K): string {
    return typeof key === 'object' && key !== null ? JSON.stringify(key) : String(key);
}
