import { Either } from '../../resilience/Either.ts';
import { computeDequeueBatch, releaseDequeueBatch } from './dequeue-batch.ts';

export const Reservator = {
    FINALIZATION: 'FINALIZATION',
    NEW: 'NEW',
    RETRY: 'RETRY',
    FAIRNESS: 'FAIRNESS',
    TIMEOUT: 'TIMEOUT'
} as const;

export type Reservator = (typeof Reservator)[keyof typeof Reservator];

export namespace DequeueController {
    export interface LaneBudget {
        readonly maxToReserve: number;
        readonly maxNumToDequeue: number;
    }

    export type LaneBudgets = Readonly<Record<Reservator, LaneBudget>>;
    /** Read once before claims. Every lane requires a positive finite budget, including recovery. */
    export type ReadLaneBudgets = (types: ReadonlySet<string>) => LaneBudgets | Promise<LaneBudgets>;

    export interface Failure<K, V> {
        readonly key: K;
        readonly value: V;
        readonly exception: Error;
    }
    export interface Success<K, V, T> {
        readonly key: K;
        readonly value: V;
        readonly computedValue: T;
    }
}

export class DequeueController<K, V, T> {
    public static readonly DEFAULT_MAX_NUM_TO_DEQUEUE = 1000;
    public static readonly DEFAULT_MAX_NUM_TO_RESERVE = 1;

    private static readonly MAX_CONSECUTIVE_FAILURE_RETRY = 5;
    private static readonly DEFAULT_RETURN_DEQUEUED_ENTRIES = false;

    private readonly log: Pick<Console, 'debug' | 'warn' | 'error'>;

    private returnDequeuedEntries = DequeueController.DEFAULT_RETURN_DEQUEUED_ENTRIES;
    private readLaneBudgets: DequeueController.ReadLaneBudgets | undefined;
    private maxNumDequeue = DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE;

    private maxNumToReserve: () => number = () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE;
    private typesToDequeue: () => Set<string> = () => new Set<string>();
    private checkIsTypesToDequeue: (types: Set<string>) => boolean = () => true;

    private newReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;
    private retryReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;
    private fairnessReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;
    private timeoutReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;
    private finalizationReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;
    private finalizationComputer?: (key: K, value: V) => Promise<K>;

    private successReleaser?: (
        m: Map<K, DequeueController.Success<K, V, T>>
    ) => Promise<Map<K, DequeueController.Success<K, V, T>>>;
    private failureReleaser?: (
        m: Map<K, DequeueController.Failure<K, V>>
    ) => Promise<Map<K, DequeueController.Failure<K, V>>>;

    private onCompleted?: (m: Map<K, DequeueController.Success<K, V, T>>) => void;
    private onFailed?: (m: Map<K, DequeueController.Failure<K, V>>) => void;
    private onPreProcessingReserved?: (m: Map<K, V>) => Promise<Map<K, V>>;

    private constructor(logger: Pick<Console, 'debug' | 'warn' | 'error'> = console) {
        this.log = logger;
    }

    static create<K, V, T>(logger?: Pick<Console, 'debug' | 'warn' | 'error'>): DequeueController<K, V, T> {
        return new DequeueController<K, V, T>(logger);
    }

    withLaneBudgets(readLaneBudgets: DequeueController.ReadLaneBudgets | undefined): this {
        this.readLaneBudgets = readLaneBudgets;
        return this;
    }

    withMaxNumToDequeue(maxNumDequeue: number): this {
        if (maxNumDequeue <= 0) {
            throw new Error(`Illegal maxNumDequeue: ${maxNumDequeue}. Must be positive.`);
        }
        this.maxNumDequeue = maxNumDequeue;
        return this;
    }

    withMaxNumToReserve(maxNumToReserve: () => number): this {
        this.maxNumToReserve = requireNonNull(maxNumToReserve);
        return this;
    }

    withInboxTypesToDequeue(typesToDequeue: () => Set<string>): this {
        this.typesToDequeue = requireNonNull(typesToDequeue);
        return this;
    }

    withReturnDequeuedEntries(returnDequeuedEntries: boolean): this {
        this.returnDequeuedEntries = returnDequeuedEntries;
        return this;
    }

    onCheckIsTypesToDequeueDo(checkIsTypesToDequeue: (types: Set<string>) => boolean): this {
        this.checkIsTypesToDequeue = requireNonNull(checkIsTypesToDequeue);
        return this;
    }

    onNewEntriesReserveDo(reservator: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>): this {
        this.newReservator = requireNonNull(reservator);
        return this;
    }

    onRetryEntriesReserveDo(retryReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>): this {
        this.retryReservator = retryReservator;
        return this;
    }

    onFairnessEntriesReserveDo(
        fairnessReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>
    ): this {
        this.fairnessReservator = fairnessReservator;
        return this;
    }

    onTimeoutEntriesReserveDo(
        timeoutReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>
    ): this {
        this.timeoutReservator = timeoutReservator;
        return this;
    }

    onFinalizationEntriesReserveDo(
        reservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>
    ): this {
        this.finalizationReservator = reservator;
        return this;
    }

    onFinalizationEntriesDo(computer?: (key: K, value: V) => Promise<K>): this {
        this.finalizationComputer = computer;
        return this;
    }

    onReleaseEntriesDo(
        successReleaser: (
            m: Map<K, DequeueController.Success<K, V, T>>
        ) => Promise<Map<K, DequeueController.Success<K, V, T>>>,
        failureReleaser: (
            m: Map<K, DequeueController.Failure<K, V>>
        ) => Promise<Map<K, DequeueController.Failure<K, V>>>
    ): this {
        this.successReleaser = requireNonNull(successReleaser);
        this.failureReleaser = requireNonNull(failureReleaser);
        return this;
    }

    onCompletedEntries(onCompleted?: (m: Map<K, DequeueController.Success<K, V, T>>) => void): this {
        this.onCompleted = onCompleted;
        return this;
    }

    onFailedEntries(onFailed?: (m: Map<K, DequeueController.Failure<K, V>>) => void): this {
        this.onFailed = onFailed;
        return this;
    }

    onPreProcessingReservedEntries(onPreProcessingReservedEntries?: (m: Map<K, V>) => Promise<Map<K, V>>): this {
        this.onPreProcessingReserved = onPreProcessingReservedEntries;
        return this;
    }

    async dequeueForCompute(
        computer: (key: K, value: V) => Promise<T>
    ): Promise<
        Map<Reservator, Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T | K>>>>
    > {
        if (this.typesToDequeue().size === 0) {
            this.log.warn('No types provided for callbacks: [newReservator, retryReservator, fairnessReservator].');
        }
        if (!this.retryReservator) {
            this.log.warn('No retry reservator configured. Retries are not performed.');
        }
        if (!this.fairnessReservator) {
            this.log.warn('No fairness reservator configured. Overdue retries are not recovered.');
        }
        requireNonNull(computer);
        requireNonNull(this.newReservator, 'newReservator is required');
        requireNonNull(this.successReleaser, 'successReleaser is required');
        requireNonNull(this.failureReleaser, 'failureReleaser is required');
        const laneBudgets = this.readLaneBudgets
            ? toValidatedLaneBudgets(await this.readLaneBudgets(this.typesToDequeue()))
            : undefined;
        const byReservator = new Map<
            Reservator,
            Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T | K>>>
        >();
        byReservator.set(Reservator.FINALIZATION, await this.dequeueFinalizations(laneBudgets?.FINALIZATION));
        const lanes = [
            [Reservator.NEW, this.newReservator],
            [Reservator.FAIRNESS, this.fairnessReservator],
            [Reservator.RETRY, this.retryReservator],
            [Reservator.TIMEOUT, this.timeoutReservator]
        ] as const;
        for (const [lane, reservator] of lanes) {
            byReservator.set(
                lane,
                reservator ? await this.dequeueLane(reservator, computer, laneBudgets?.[lane]) : new Map()
            );
        }
        return byReservator;
    }

    private async dequeueFinalizations(
        budget: DequeueController.LaneBudget | undefined
    ): Promise<Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, K>>>> {
        const computed = new Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, K>>>();
        if (!this.finalizationReservator || !this.finalizationComputer) {
            return computed;
        }
        const maxNumToReserve = budget ? Math.min(budget.maxToReserve, budget.maxNumToDequeue) : this.maxNumToReserve();
        if (maxNumToReserve <= 0) {
            return computed;
        }
        const reserved = await this.finalizationReservator(this.typesToDequeue(), maxNumToReserve);
        const finalized = await computeDequeueBatch({
            entries: reserved,
            computer: this.finalizationComputer,
            log: this.log,
            purpose: 'finalization-recovery'
        });
        return this.returnDequeuedEntries ? finalized : new Map();
    }

    private async dequeueLane(
        reservator: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>,
        computer: (key: K, value: V) => Promise<T>,
        budget: DequeueController.LaneBudget | undefined
    ): Promise<Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>> {
        const maxNumDequeue = budget?.maxNumToDequeue ?? this.maxNumDequeue;
        let consecutiveFailureCounter = 0;
        let claimedCount = 0;
        const allComputed = new Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>();
        while (
            this.checkIsTypesToDequeue(this.typesToDequeue()) &&
            claimedCount < maxNumDequeue &&
            consecutiveFailureCounter < DequeueController.MAX_CONSECUTIVE_FAILURE_RETRY
        ) {
            try {
                const numToReserve = Math.min(
                    budget?.maxToReserve ?? this.maxNumToReserve(),
                    maxNumDequeue - claimedCount
                );
                if (numToReserve <= 0) {
                    return allComputed;
                }
                const reserved = await reservator(this.typesToDequeue(), numToReserve) ?? new Map<K, V>();
                claimedCount += reserved.size;
                const processedCount = await this.computeAndReleaseReserved(reserved, computer, allComputed);
                consecutiveFailureCounter = 0;
                if (processedCount === 0) {
                    return allComputed;
                }
            }
            catch (error) {
                const exception = error instanceof Error ? error : new Error(String(error));
                consecutiveFailureCounter += 1;
                if (!await this.backoffAfterDequeueFailure(exception, consecutiveFailureCounter)) {
                    this.log.warn('Backoff with sleep interrupted, returning quietly.');
                    break;
                }
            }
        }
        if (consecutiveFailureCounter >= DequeueController.MAX_CONSECUTIVE_FAILURE_RETRY) {
            this.log.warn(`Dequeue experienced ${consecutiveFailureCounter} failures in a row. Giving up ...`);
        }
        return allComputed;
    }

    private async computeAndReleaseReserved(
        reserved: Map<K, V>,
        computer: (key: K, value: V) => Promise<T>,
        retained: Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>
    ): Promise<number> {
        const entries = this.onPreProcessingReserved ? await this.onPreProcessingReserved(reserved) : reserved;
        const computed = await computeDequeueBatch({ entries, computer, log: this.log, purpose: 'processing' });
        await releaseDequeueBatch(computed, {
            successReleaser: requireNonNull(this.successReleaser),
            failureReleaser: requireNonNull(this.failureReleaser),
            onCompleted: this.onCompleted,
            onFailed: this.onFailed
        });
        if (this.returnDequeuedEntries) {
            for (const [key, result] of computed) {
                retained.set(key, result);
            }
        }
        return computed.size;
    }

    private async backoffAfterDequeueFailure(exception: Error, failureCounter: number): Promise<boolean> {
        this.log.error(
            `Exception caught while working on queue with these types: ${Array.from(this.typesToDequeue()).join(',')}`,
            exception
        );
        try {
            const sleepSeconds = toExponentialBackoffSeconds(failureCounter);
            this.log.warn(`${failureCounter} attempt. Backoff sleeping ${sleepSeconds} secs`);
            await sleep(sleepSeconds * 1000);
            return true;
        }
        catch (e) {
            this.log.warn('Exception caught in backoff', e);
            return false;
        }
    }
}

function toValidatedLaneBudgets(budgets: DequeueController.LaneBudgets): DequeueController.LaneBudgets {
    const entries = Object.values(Reservator).map((lane) => {
        const budget = budgets?.[lane];
        if (
            !budget ||
            ![budget.maxToReserve, budget.maxNumToDequeue].every(isPositiveSafeInteger)
        ) {
            throw new TypeError(`Lane ${lane} requires positive safe-integer reservation and dequeue budgets`);
        }
        return [lane, { maxToReserve: budget.maxToReserve, maxNumToDequeue: budget.maxNumToDequeue }] as const;
    });
    return Object.fromEntries(entries) as DequeueController.LaneBudgets;
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function requireNonNull<T>(v: T | null | undefined, message = 'Value was null/undefined'): T {
    if (v === null || v === undefined) {
        throw new Error(message);
    }
    return v;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal exponential backoff in seconds.
 */
function toExponentialBackoffSeconds(failureCounter: number, maxSeconds = 60): number {
    const fc = Math.max(1, Math.floor(failureCounter));
    const secs = Math.pow(2, fc - 1); // 1,2,4,8,...
    return Math.min(secs, maxSeconds);
}
