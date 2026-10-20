import { Either } from '../../resilience/Either.ts';
import { ExclusionKeyedAdmission } from '../../resilience/exclusion-keyed-admission.ts';
import { toError } from '../../resilience/to-error.ts';
import { isNotReadyException } from '../resource-inbox/not-ready-exception.ts';
import type { DequeueController } from './dequeue-controller.ts';

export namespace DequeueBatch {
    export type EntryResult<K, V, T> = Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>;

    export interface Release<K, V, T> {
        readonly successReleaser: (
            entries: Map<K, DequeueController.Success<K, V, T>>
        ) => Promise<Map<K, DequeueController.Success<K, V, T>>>;
        readonly failureReleaser: (
            entries: Map<K, DequeueController.Failure<K, V>>
        ) => Promise<Map<K, DequeueController.Failure<K, V>>>;
        readonly onCompleted: ((entries: Map<K, DequeueController.Success<K, V, T>>) => void) | undefined;
        readonly onFailed: ((entries: Map<K, DequeueController.Failure<K, V>>) => void) | undefined;
    }

    export interface Input<K, V, T> {
        /** At most this many entries compute at once; 1 computes them in the order they were added. */
        readonly maxConcurrentComputes: number;
        readonly computer: (key: K, value: V) => Promise<T>;
        /** An entry computes after every earlier unsettled entry whose exclusion key overlaps its own. */
        readonly toExclusionKey: ((key: K, value: V) => string | undefined) | undefined;
        readonly release: Release<K, V, T>;
        readonly log: Pick<Console, 'error'>;
    }
}

interface DequeueEntryInput<K, V, T> {
    readonly key: K;
    readonly value: V;
    readonly computer: (key: K, value: V) => Promise<T>;
    readonly log: Pick<Console, 'error'>;
    readonly purpose: 'processing' | 'finalization-recovery';
}

interface DequeueBatchSettlement<K, V, T> {
    readonly key: K;
    /** Absent when the entry's release failed: the batch then rejects with the first such error. */
    readonly released: DequeueBatch.EntryResult<K, V, T> | undefined;
}

/**
 * The entries one lane invocation claimed and has not yet released. Each entry computes once admitted and is released
 * on its own as soon as it settles, so its slot frees without waiting for the batch's slowest entry. A release error is
 * kept, not thrown: the other entries still compute and release, and draining rethrows the first one.
 */
export class DequeueBatch<K, V, T> {
    private readonly input: DequeueBatch.Input<K, V, T>;
    private readonly admission: ExclusionKeyedAdmission;
    private readonly unreleased = new Set<Promise<DequeueBatchSettlement<K, V, T>>>();
    private readonly settlements: Promise<DequeueBatchSettlement<K, V, T>>[] = [];
    private firstError: Error | undefined;

    constructor(input: DequeueBatch.Input<K, V, T>) {
        this.input = input;
        this.admission = new ExclusionKeyedAdmission({ maxConcurrent: input.maxConcurrentComputes });
    }

    add(entries: Map<K, V>): void {
        for (const [key, value] of entries) {
            const settlement = this.admission
                .admit(
                    this.input.toExclusionKey?.(key, value),
                    () =>
                        computeDequeueEntry({
                            key,
                            value,
                            computer: this.input.computer,
                            log: this.input.log,
                            purpose: 'processing'
                        })
                )
                .then((computed) => releaseDequeueEntry(computed, this.input.release))
                .then((released) => ({ key, released }), (error) => {
                    this.firstError ??= toError(error);
                    return { key, released: undefined };
                });
            this.unreleased.add(settlement);
            this.settlements.push(settlement);
            void settlement.then(() => this.unreleased.delete(settlement));
        }
    }

    getUnreleasedCount(): number {
        return this.unreleased.size;
    }

    /** A reservation or preprocessing error ends the lane like a release error; only the first error is rethrown. */
    stop(error: Error): void {
        this.firstError ??= error;
    }

    /** Resolves once fewer than the compute bound are unreleased; false once an error stopped the batch. */
    async waitForFreeSlot(): Promise<boolean> {
        while (this.firstError === undefined && this.unreleased.size >= this.input.maxConcurrentComputes) {
            await Promise.race(this.unreleased);
        }
        return this.firstError === undefined;
    }

    /** Waits for every entry to compute and release, then rethrows the first error or returns them in claim order. */
    async drain(): Promise<Map<K, DequeueBatch.EntryResult<K, V, T>>> {
        const settled = await Promise.all(this.settlements);
        if (this.firstError !== undefined) {
            throw this.firstError;
        }
        return new Map(settled.flatMap(({ key, released }) => released === undefined ? [] : [[key, released]]));
    }
}

export async function computeDequeueEntry<K, V, T>(
    { key, value, computer, log, purpose }: DequeueEntryInput<K, V, T>
): Promise<DequeueBatch.EntryResult<K, V, T>> {
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

/** A releaser that resolves without the entry leaves it as computed. */
async function releaseDequeueEntry<K, V, T>(
    computed: DequeueBatch.EntryResult<K, V, T>,
    release: DequeueBatch.Release<K, V, T>
): Promise<DequeueBatch.EntryResult<K, V, T>> {
    return await computed.fold<Promise<DequeueBatch.EntryResult<K, V, T>>>(
        async (failure) => {
            const [released = failure] = (await release.failureReleaser(new Map([[failure.key, failure]]))).values();
            release.onFailed?.(new Map([[failure.key, released]]));
            return Either.ofLeft(released);
        },
        async (success) => {
            const [released = success] = (await release.successReleaser(new Map([[success.key, success]]))).values();
            release.onCompleted?.(new Map([[success.key, released]]));
            return Either.ofRight(released);
        }
    );
}

export function toDequeuedKeyText<K>(key: K): string {
    return typeof key === 'object' && key !== null ? JSON.stringify(key) : String(key);
}
