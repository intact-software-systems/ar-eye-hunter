import type { Either } from '../../resilience/Either.ts';
import { toError } from '../../resilience/to-error.ts';
import { computeDequeueEntry, DequeueLaneFlight } from './dequeue-lane-flight.ts';

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
        /** How many claimed rows compute together; 1 computes them in turn, in claim order. */
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

    /** Claims up to `numToReserve` entries of the given types; claiming fewer means none more are claimable now. */
    export type EntryReservator<K, V> = (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;
}

interface ReserveIntoFlightInput<K, V, T> {
    readonly reservator: DequeueController.EntryReservator<K, V>;
    readonly flight: DequeueLaneFlight<K, V, T>;
    readonly work: DequeueLaneFlight.Work<K, V, T>;
    readonly budget: DequeueController.LaneBudget | undefined;
    /** Absent for a standing flight: the pass then neither waits for a compute slot nor joins what it claimed. */
    readonly settlements: Promise<DequeueLaneFlight.Settlement<K, V, T>>[] | undefined;
}

export class DequeueController<K, V, T> {
    public static readonly DEFAULT_MAX_NUM_TO_DEQUEUE = 1000;
    /**
     * The rows one lane of a draining pass claims before the pass moves on to the next lane. A lane whose rows keep
     * coming due would otherwise hold the pass, and the work of the lanes after it, until the dequeue bound; at its share
     * the pass serves NEW, FAIRNESS, RETRY and TIMEOUT in turn, and a lane left with work is reached by the next pass.
     */
    public static readonly DRAINING_LANE_CLAIMS_PER_PASS = 8;
    public static readonly DEFAULT_MAX_NUM_TO_RESERVE = 1;

    private static readonly DEFAULT_RETURN_DEQUEUED_ENTRIES = false;

    private readonly log: Pick<Console, 'debug' | 'warn' | 'error'>;

    private returnDequeuedEntries = DequeueController.DEFAULT_RETURN_DEQUEUED_ENTRIES;
    private readLaneBudgets: DequeueController.ReadLaneBudgets | undefined;
    private workAdvertisement: DequeueController.WorkAdvertisement | undefined;
    private maxNumDequeue = DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE;

    private maxNumToReserve: () => number = () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE;
    private typesToDequeue: () => Set<string> = () => new Set<string>();
    private admitsReservation: (types: Set<string>) => boolean = () => true;
    private toExclusionKey: ((key: K, value: V) => string | undefined) | undefined;
    private standingFlight: DequeueLaneFlight<K, V, T> | undefined;

    private newReservator?: DequeueController.EntryReservator<K, V>;
    private retryReservator?: DequeueController.EntryReservator<K, V>;
    private fairnessReservator?: DequeueController.EntryReservator<K, V>;
    private timeoutReservator?: DequeueController.EntryReservator<K, V>;
    private finalizationReservator?: DequeueController.EntryReservator<K, V>;
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
    private onClaimed?: (m: Map<K, V>) => void;

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

    /** Claimed rows with overlapping exclusion keys compute one after another; the lane's other rows still run together. */
    withComputeExclusion(toExclusionKey: ((key: K, value: V) => string | undefined) | undefined): this {
        this.toExclusionKey = toExclusionKey;
        return this;
    }

    /**
     * The flight every processing lane adds its claims to instead of one of its own, kept by the owner across passes.
     * A pass then tops it up to its hold bound and returns without waiting for what it claimed: those rows compute and
     * release after the pass, and the flight's own exclusion and compute bound order them with the rows of earlier
     * passes. The recovery lanes top up before NEW, so a NEW backlog never leaves them without a place. A pass then
     * returns no dequeued entries, whatever `withReturnDequeuedEntries` says. Absent, each lane computes its claims in a
     * flight of its own that the pass drains before it returns.
     */
    withStandingFlight(standingFlight: DequeueLaneFlight<K, V, T> | undefined): this {
        this.standingFlight = standingFlight;
        return this;
    }

    /** Asked before every reservation of a lane; false ends the lane, and the rows already reserved still finish. */
    onReservationAdmissionDo(admitsReservation: (types: Set<string>) => boolean): this {
        this.admitsReservation = requireNonNull(admitsReservation);
        return this;
    }

    onNewEntriesReserveDo(reservator: DequeueController.EntryReservator<K, V>): this {
        this.newReservator = requireNonNull(reservator);
        return this;
    }

    onRetryEntriesReserveDo(retryReservator?: DequeueController.EntryReservator<K, V>): this {
        this.retryReservator = retryReservator;
        return this;
    }

    onFairnessEntriesReserveDo(
        fairnessReservator?: DequeueController.EntryReservator<K, V>
    ): this {
        this.fairnessReservator = fairnessReservator;
        return this;
    }

    onTimeoutEntriesReserveDo(
        timeoutReservator?: DequeueController.EntryReservator<K, V>
    ): this {
        this.timeoutReservator = timeoutReservator;
        return this;
    }

    onFinalizationEntriesReserveDo(
        reservator?: DequeueController.EntryReservator<K, V>
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

    /** Told of the entries each processing-lane reservation claimed, once preprocessed and before any computes. */
    onClaimedEntries(onClaimed?: (m: Map<K, V>) => void): this {
        this.onClaimed = onClaimed;
        return this;
    }

    /** A standing flight's release error kept since the last pass rejects this pass before it claims anything. */
    async dequeueForCompute(
        computer: (key: K, value: V) => Promise<T>
    ): Promise<
        Map<Reservator, Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T | K>>>>
    > {
        this.warnOfMissingReservators();
        requireNonNull(computer);
        requireNonNull(this.newReservator, 'newReservator is required');
        requireNonNull(this.successReleaser, 'successReleaser is required');
        requireNonNull(this.failureReleaser, 'failureReleaser is required');
        this.rethrowStandingFlightError();
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
        for (const [lane, reservator] of this.toProcessingLanes()) {
            byReservator.set(
                lane,
                reservator && this.isOffered(lane)
                    ? await this.dequeueLane(reservator, computer, laneBudgets?.[lane])
                    : new Map()
            );
        }
        this.rethrowStandingFlightError();
        return byReservator;
    }

    private warnOfMissingReservators(): void {
        if (this.typesToDequeue().size === 0) {
            this.log.warn('No types provided for callbacks: [newReservator, retryReservator, fairnessReservator].');
        }
        if (!this.retryReservator) {
            this.log.warn('No retry reservator configured. Retries are not performed.');
        }
        if (!this.fairnessReservator) {
            this.log.warn('No fairness reservator configured. Overdue retries are not recovered.');
        }
    }

    private rethrowStandingFlightError(): void {
        const error = this.standingFlight?.takeFirstError();
        if (error !== undefined) {
            throw error;
        }
    }

    private toProcessingLanes(): readonly (readonly [
        Reservator,
        DequeueController.EntryReservator<K, V> | undefined
    ])[] {
        const recovery = [
            [Reservator.FAIRNESS, this.fairnessReservator],
            [Reservator.RETRY, this.retryReservator],
            [Reservator.TIMEOUT, this.timeoutReservator]
        ] as const;
        const fresh = [Reservator.NEW, this.newReservator] as const;
        return this.standingFlight ? [...recovery, fresh] : [fresh, ...recovery];
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
        for (const [key, value] of reserved) {
            const finalized = await computeDequeueEntry({
                key,
                value,
                computer: this.finalizationComputer,
                log: this.log,
                purpose: 'finalization-recovery'
            });
            computed.set(key, finalized);
        }
        return this.returnDequeuedEntries ? computed : new Map();
    }

    /**
     * Claims rows whenever the flight has a free place and, without a standing flight, fewer than the lane's compute
     * bound are unreleased; each row releases as soon as it settles, so one slow row holds only its own slot. Without a
     * standing flight the pass joins every row it claimed before it returns. A reservation or release error claims
     * nothing more; the rows already claimed still finish, and the error is rethrown: the caller owns its backoff.
     */
    private async dequeueLane(
        reservator: DequeueController.EntryReservator<K, V>,
        computer: (key: K, value: V) => Promise<T>,
        budget: DequeueController.LaneBudget | undefined
    ): Promise<Map<K, Either<DequeueController.Failure<K, V>, DequeueController.Success<K, V, T>>>> {
        const work = { computer, release: this.toRelease(), log: this.log };
        if (this.standingFlight) {
            await this.reserveIntoFlight({
                reservator,
                flight: this.standingFlight,
                work,
                budget,
                settlements: undefined
            });
            return new Map();
        }
        const maxConcurrentComputes = budget?.maxConcurrentComputes ?? 1;
        const flight = new DequeueLaneFlight<K, V, T>({
            maxConcurrentComputes,
            // A serial lane still claims a whole reservation at once.
            maxUnreleased: Math.max(budget?.maxToReserve ?? this.maxNumToReserve(), maxConcurrentComputes),
            keyedChainsFirst: false,
            toExclusionKey: this.toExclusionKey,
            releaseFailureClock: undefined,
            retainSettlement: undefined
        });
        const settlements: Promise<DequeueLaneFlight.Settlement<K, V, T>>[] = [];
        await this.reserveIntoFlight({ reservator, flight, work, budget, settlements });
        const released = await flight.drain(settlements);
        return this.returnDequeuedEntries ? released : new Map();
    }

    private toRelease(): DequeueLaneFlight.Release<K, V, T> {
        return {
            successReleaser: requireNonNull(this.successReleaser),
            failureReleaser: requireNonNull(this.failureReleaser),
            onCompleted: this.onCompleted,
            onFailed: this.onFailed
        };
    }

    /**
     * A reservation that claimed fewer than it asked for found every row it could claim, so the lane ends for this pass;
     * rows that arrive meanwhile wait for the next pass. An error stops the flight instead of escaping.
     */
    private async reserveIntoFlight(input: ReserveIntoFlightInput<K, V, T>): Promise<void> {
        const { reservator, flight, budget, settlements } = input;
        const maxNumDequeue = budget?.maxNumToDequeue ?? this.maxNumDequeue;
        let claimedCount = 0;
        try {
            while (
                (settlements === undefined ? !flight.isStopped() : await flight.waitForFreeSlot()) &&
                this.admitsReservation(this.typesToDequeue()) && claimedCount < maxNumDequeue
            ) {
                const maxToReserve = budget?.maxToReserve ?? this.maxNumToReserve();
                const numToReserve = Math.min(maxToReserve, flight.getFreePlaceCount(), maxNumDequeue - claimedCount);
                if (numToReserve <= 0) {
                    return;
                }
                if (!isPositiveSafeInteger(numToReserve)) {
                    throw new TypeError('Reservation request requires a positive safe integer');
                }
                const reserved = await reservator(this.typesToDequeue(), numToReserve) ?? new Map<K, V>();
                claimedCount += reserved.size;
                const entries = this.onPreProcessingReserved ? await this.onPreProcessingReserved(reserved) : reserved;
                const added = flight.add(entries, input.work);
                settlements?.push(...added);
                this.onClaimed?.(entries);
                if (entries.size === 0 || reserved.size < numToReserve) {
                    return;
                }
            }
        }
        catch (error) {
            flight.stop(toError(error));
        }
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
