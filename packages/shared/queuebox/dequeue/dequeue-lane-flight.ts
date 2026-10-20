import { Either } from '../../resilience/Either.ts';
import { ExclusionKeyedAdmission } from '../../resilience/exclusion-keyed-admission.ts';
import { toError } from '../../resilience/to-error.ts';
import { isNotReadyException } from '../resource-inbox/not-ready-exception.ts';
import type { DequeueController } from './dequeue-controller.ts';

export namespace DequeueLaneFlight {
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

    /** How the entries of one reservation compute and release: the pass that claimed them decides both. */
    export interface Work<K, V, T> {
        readonly computer: (key: K, value: V) => Promise<T>;
        readonly release: Release<K, V, T>;
    }

    export interface Settlement<K, V, T> {
        readonly key: K;
        /** Absent when the entry's release failed: the flight then keeps the first such error. */
        readonly released: EntryResult<K, V, T> | undefined;
    }

    export interface Input<K, V> {
        /** At most this many entries compute at once; 1 computes them in the order they were added. */
        readonly maxConcurrentComputes: number;
        /** At most this many added entries are unreleased at once, whether computing, waiting to compute or releasing. */
        readonly maxUnreleased: number;
        /** Whether a keyed entry takes a freed compute slot ahead of every waiting keyless entry. */
        readonly keyedRunsFirst: boolean;
        /** An entry computes after every earlier unsettled entry whose exclusion key overlaps its own. */
        readonly toExclusionKey: ((key: K, value: V) => string | undefined) | undefined;
        readonly log: Pick<Console, 'error'>;
        /**
         * Told of each added entry with a promise that settles once the entry is released, rejecting with its release
         * error. Absent, nothing outside the flight waits for its entries.
         */
        readonly retainSettlement: ((settlement: Promise<void>) => void) | undefined;
    }
}

interface DequeueEntryInput<K, V, T> {
    readonly key: K;
    readonly value: V;
    readonly computer: (key: K, value: V) => Promise<T>;
    readonly log: Pick<Console, 'error'>;
    readonly purpose: 'processing' | 'finalization-recovery';
}

/**
 * The claimed entries that are not yet released, across every reservation added to it. Each entry computes once
 * admitted and is released on its own as soon as it settles, so its slot and its place free without waiting for any
 * other entry. A release error is kept, not thrown: the other entries still compute and release, and the owner takes
 * the first one. A flight outlives one pass when its owner keeps it, so entries of several passes share its slots.
 */
export class DequeueLaneFlight<K, V, T> {
    private readonly input: DequeueLaneFlight.Input<K, V>;
    private readonly admission: ExclusionKeyedAdmission;
    private readonly unreleased = new Map<Promise<DequeueLaneFlight.Settlement<K, V, T>>, K>();
    private firstError: Error | undefined;

    constructor(input: DequeueLaneFlight.Input<K, V>) {
        this.input = input;
        this.admission = new ExclusionKeyedAdmission({
            maxConcurrent: input.maxConcurrentComputes,
            keyedRunsFirst: input.keyedRunsFirst
        });
    }

    /** Returns each added entry's settlement, in the order of `entries`; none of them rejects. */
    add(entries: Map<K, V>, work: DequeueLaneFlight.Work<K, V, T>): Promise<DequeueLaneFlight.Settlement<K, V, T>>[] {
        return [...entries].map(([key, value]) => this.addEntry(key, value, work));
    }

    getUnreleasedCount(): number {
        return this.unreleased.size;
    }

    getUnreleasedKeys(): K[] {
        return [...this.unreleased.values()];
    }

    getFreePlaceCount(): number {
        return Math.max(0, this.input.maxUnreleased - this.unreleased.size);
    }

    isStopped(): boolean {
        return this.firstError !== undefined;
    }

    /** A reservation or preprocessing error stops further claims like a release error; only the first one is kept. */
    stop(error: Error): void {
        this.firstError ??= error;
    }

    /** Returns the first kept error, if any, and forgets it, so the owner rethrows it once and claims again after. */
    takeFirstError(): Error | undefined {
        const error = this.firstError;
        this.firstError = undefined;
        return error;
    }

    /** Resolves once fewer than the compute bound are unreleased; false once an error stopped the flight. */
    async waitForFreeSlot(): Promise<boolean> {
        while (this.firstError === undefined && this.unreleased.size >= this.input.maxConcurrentComputes) {
            await Promise.race(this.unreleased.keys());
        }
        return this.firstError === undefined;
    }

    /** Waits for the given settlements, then rethrows the first kept error or returns their entries in claim order. */
    async drain(
        settlements: readonly Promise<DequeueLaneFlight.Settlement<K, V, T>>[]
    ): Promise<Map<K, DequeueLaneFlight.EntryResult<K, V, T>>> {
        const settled = await Promise.all(settlements);
        const error = this.takeFirstError();
        if (error !== undefined) {
            throw error;
        }
        return new Map(settled.flatMap(({ key, released }) => released === undefined ? [] : [[key, released]]));
    }

    private addEntry(
        key: K,
        value: V,
        work: DequeueLaneFlight.Work<K, V, T>
    ): Promise<DequeueLaneFlight.Settlement<K, V, T>> {
        const released = this.admission
            .admit(
                this.input.toExclusionKey?.(key, value),
                () =>
                    computeDequeueEntry({
                        key,
                        value,
                        computer: work.computer,
                        log: this.input.log,
                        purpose: 'processing'
                    })
            )
            .then((computed) => releaseDequeueEntry(computed, work.release));
        const settlement: Promise<DequeueLaneFlight.Settlement<K, V, T>> = released
            .then((entry) => ({ key, released: entry }), (error) => {
                this.firstError ??= toError(error);
                return { key, released: undefined };
            })
            .finally(() => this.unreleased.delete(settlement));
        this.unreleased.set(settlement, key);
        this.input.retainSettlement?.(settlement.then(async () => {
            await released;
        }));
        return settlement;
    }
}

export async function computeDequeueEntry<K, V, T>(
    { key, value, computer, log, purpose }: DequeueEntryInput<K, V, T>
): Promise<DequeueLaneFlight.EntryResult<K, V, T>> {
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
    computed: DequeueLaneFlight.EntryResult<K, V, T>,
    release: DequeueLaneFlight.Release<K, V, T>
): Promise<DequeueLaneFlight.EntryResult<K, V, T>> {
    return await computed.fold<Promise<DequeueLaneFlight.EntryResult<K, V, T>>>(
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
