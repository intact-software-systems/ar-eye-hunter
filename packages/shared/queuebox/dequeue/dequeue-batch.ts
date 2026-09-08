import { Either, EitherCollectors } from '../../resilience/Either.ts';
import { isNotReadyException } from '../resource-inbox/not-ready-exception.ts';
import type { DequeueController } from './dequeue-controller.ts';

interface DequeueBatchInput<K, V, T> {
    readonly entries: Map<K, V>;
    readonly computer: (key: K, value: V) => Promise<T>;
    readonly log: Pick<Console, 'error'>;
    readonly purpose: 'processing' | 'finalization-recovery';
}

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
    { entries, computer, log, purpose }: DequeueBatchInput<K, V, T>
): Promise<Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>> {
    const computed = new Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>();
    for (const [key, value] of entries) {
        try {
            computed.set(key, Either.ofRight({ key, value, computedValue: await computer(key, value) }));
        }
        catch (error) {
            const exception = error instanceof Error ? error : new Error(String(error));
            if (purpose === 'finalization-recovery' || !isNotReadyException(exception)) {
                const operation = purpose === 'finalization-recovery' ? 'Finalization recovery' : 'Computer';
                log.error(`${operation} failed on dequeued key ${String(key)}.`, exception);
            }
            computed.set(key, Either.ofLeft({ key, value, exception }));
        }
    }
    return computed;
}

export async function releaseDequeueBatch<K, V, T>(
    computed: Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>,
    release: DequeueBatchRelease<K, V, T>
): Promise<void> {
    const { rightByKey: successes, leftByKey: failures } = EitherCollectors.toMapFoldBoth(computed);
    if (successes.size > 0) {
        const released = await release.successReleaser(successes);
        for (const [key, result] of released) {
            computed.set(key, Either.ofRight(result));
        }
    }
    if (successes.size > 0 || failures.size === 0) {
        release.onCompleted?.(EitherCollectors.toMapFoldRights(computed));
    }
    if (failures.size > 0) {
        const released = await release.failureReleaser(failures);
        for (const [key, result] of released) {
            computed.set(key, Either.ofLeft(result));
        }
        release.onFailed?.(EitherCollectors.toMapFoldLefts(computed));
    }
}
