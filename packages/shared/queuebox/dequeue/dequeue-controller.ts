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
        /** How many rows of one round's reservation compute together; 1 computes them in turn. */
        readonly maxConcurrentComputes: number;
    }

    export type LaneBudgets = Readonly<Record<Reservator, LaneBudget>>;
    /** Read once before claims. Every lane requires a positive finite budget, including recovery. */
    export type ReadLaneBudgets = (types: ReadonlySet<string>) => LaneBudgets | Promise<LaneBudgets>;
    /** Which lanes hold a row a reservation could claim now; a lane reported empty is offered no reservation. */
    export type WorkAdvertisement = Readonly<Record<Reservator, boolean>>;

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

/** One reservation round's rows and how many of them compute together. */
interface DequeueReservedRound<K, V> {
    readonly reserved: Map<K, V>;
    readonly maxConcurrentComputes: number;
}

export class DequeueController<K, V, T> {
    public static readonly DEFAULT_MAX_NUM_TO_DEQUEUE = 1000;
    public static readonly DEFAULT_MAX_NUM_TO_RESERVE = 1;

    private static readonly DEFAULT_RETURN_DEQUEUED_ENTRIES = false;

    private readonly log: Pick<Console, 'debug' | 'warn' | 'error'>;

    private returnDequeuedEntries = DequeueController.DEFAULT_RETURN_DEQUEUED_ENTRIES;
    private readLaneBudgets: DequeueController.ReadLaneBudgets | undefined;
    private workAdvertisement: DequeueController.WorkAdvertisement | undefined;
    private maxNumDequeue = DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE;

    private maxNumToReserve: () => number = () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE;
    private typesToDequeue: () => Set<string> = () => new Set<string>();
    private admitsRound: (types: Set<string>) => boolean = () => true;

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

    /** The probe that preceded this pass; without one every lane is offered a reservation. */
    withWorkAdvertisement(workAdvertisement: DequeueController.WorkAdvertisement | undefined): this {
        this.workAdvertisement = workAdvertisement;
        return this;
    }

    withMaxNumToDequeue(maxNumDequeue: number): this {
        if (!isPositiveSafeInteger(maxNumDequeue)) {
            throw new Error(`Illegal maxNumDequeue: ${maxNumDequeue}. Must be a positive safe integer.`);
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

    /** Asked before every reservation round of a lane; false ends the lane, and the rows already reserved still finish. */
    onRoundAdmissionDo(admitsRound: (types: Set<string>) => boolean): this {
        this.admitsRound = requireNonNull(admitsRound);
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
        byReservator.set(
            Reservator.FINALIZATION,
            this.isOffered(Reservator.FINALIZATION)
                ? await this.dequeueFinalizations(laneBudgets?.FINALIZATION)
                : new Map()
        );
        const lanes = [
            [Reservator.NEW, this.newReservator],
            [Reservator.FAIRNESS, this.fairnessReservator],
            [Reservator.RETRY, this.retryReservator],
            [Reservator.TIMEOUT, this.timeoutReservator]
        ] as const;
        for (const [lane, reservator] of lanes) {
            byReservator.set(
                lane,
                reservator && this.isOffered(lane)
                    ? await this.dequeueLane(reservator, computer, laneBudgets?.[lane])
                    : new Map()
            );
        }
        return byReservator;
    }

    private isOffered(lane: Reservator): boolean {
        return this.workAdvertisement === undefined || this.workAdvertisement[lane];
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
        if (!isPositiveSafeInteger(maxNumToReserve)) {
            throw new TypeError('Reservation request requires a positive safe integer');
        }
        const reserved = await this.finalizationReservator(this.typesToDequeue(), maxNumToReserve);
        const finalized = await computeDequeueBatch({
            entries: reserved,
            computer: this.finalizationComputer,
            log: this.log,
            purpose: 'finalization-recovery',
            maxConcurrentComputes: 1
        });
        return this.returnDequeuedEntries ? finalized : new Map();
    }

    /**
     * A round that claimed fewer than it asked for found every row it could claim, so the lane ends for this pass;
     * rows that arrive meanwhile wait for the next pass. A reservation or release error leaves the lane at once:
     * the caller owns its backoff, never this slot.
     */
    private async dequeueLane(
        reservator: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>,
        computer: (key: K, value: V) => Promise<T>,
        budget: DequeueController.LaneBudget | undefined
    ): Promise<Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>> {
        const maxNumDequeue = budget?.maxNumToDequeue ?? this.maxNumDequeue;
        let claimedCount = 0;
        const allComputed = new Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>();
        while (this.admitsRound(this.typesToDequeue()) && claimedCount < maxNumDequeue) {
            const numToReserve = Math.min(
                budget?.maxToReserve ?? this.maxNumToReserve(),
                maxNumDequeue - claimedCount
            );
            if (numToReserve <= 0) {
                return allComputed;
            }
            if (!isPositiveSafeInteger(numToReserve)) {
                throw new TypeError('Reservation request requires a positive safe integer');
            }
            const reserved = await reservator(this.typesToDequeue(), numToReserve) ?? new Map<K, V>();
            claimedCount += reserved.size;
            const computedCount = await this.computeAndReleaseReserved(
                { reserved, maxConcurrentComputes: budget?.maxConcurrentComputes ?? 1 },
                computer,
                allComputed
            );
            if (computedCount === 0 || reserved.size < numToReserve) {
                return allComputed;
            }
        }
        return allComputed;
    }

    private async computeAndReleaseReserved(
        round: DequeueReservedRound<K, V>,
        computer: (key: K, value: V) => Promise<T>,
        retained: Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>
    ): Promise<number> {
        const { reserved, maxConcurrentComputes } = round;
        const entries = this.onPreProcessingReserved ? await this.onPreProcessingReserved(reserved) : reserved;
        const computed = await computeDequeueBatch({
            entries,
            computer,
            log: this.log,
            purpose: 'processing',
            maxConcurrentComputes
        });
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
}

export function hasAdvertisedDequeueWork(advertisement: DequeueController.WorkAdvertisement): boolean {
    return Object.values(Reservator).some((lane) => advertisement[lane]);
}

function toValidatedLaneBudgets(budgets: DequeueController.LaneBudgets): DequeueController.LaneBudgets {
    const entries = Object.values(Reservator).map((lane) => {
        const budget = budgets?.[lane];
        const snapshot = budget && {
            maxToReserve: budget.maxToReserve,
            maxNumToDequeue: budget.maxNumToDequeue,
            maxConcurrentComputes: budget.maxConcurrentComputes
        };
        if (
            !snapshot ||
            ![snapshot.maxToReserve, snapshot.maxNumToDequeue, snapshot.maxConcurrentComputes].every(
                isPositiveSafeInteger
            )
        ) {
            throw new TypeError(`Lane ${lane} requires positive safe-integer reservation, dequeue and compute budgets`);
        }
        return [lane, snapshot] as const;
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
