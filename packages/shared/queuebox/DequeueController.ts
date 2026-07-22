import { Either, EitherCollectors } from '../resilience/Either.ts';

export interface Logger {
    debug(message: string, ...args: unknown[]): void;

    warn(message: string, ...args: unknown[]): void;

    error(message: string, ...args: unknown[]): void;
}

const defaultLogger: Logger = {
    debug: (m, ...a) => console.debug(m, ...a),
    warn: (m, ...a) => console.warn(m, ...a),
    error: (m, ...a) => console.error(m, ...a),
};

function requireNonNull<T>(v: T | null | undefined, message = 'Value was null/undefined'): T {
    if (v === null || v === undefined) throw new Error(message);
    return v;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal exponential backoff in seconds.
 * If you have an existing BackoffUtil in your TS codebase, replace this.
 */
function toExponentialBackoffSeconds(failureCounter: number, maxSeconds = 60): number {
    const fc = Math.max(1, Math.floor(failureCounter));
    const secs = Math.pow(2, fc - 1); // 1,2,4,8,...
    return Math.min(secs, maxSeconds);
}

export enum Reservator {
    NEW = 'NEW',
    RETRY = 'RETRY',
    FAILED = 'FAILED',
    FAIRNESS = 'FAIRNESS',
    TIMEOUT = 'TIMEOUT',
}

export class FailureDto<K, V> {
    constructor(
        public readonly key: K,
        public readonly value: V,
        public readonly exception: Error,
    ) {
    }
}

export class SuccessDto<K, V, T> {
    constructor(
        public readonly key: K,
        public readonly value: V,
        public readonly computedValue: T,
    ) {
    }
}

export class DequeueController<K, V, T> {
    public static readonly DEFAULT_MAX_NUM_TO_DEQUEUE = 1000;
    public static readonly DEFAULT_MAX_NUM_TO_RESERVE = 1;
    public static readonly DEFAULT_MAX_RETRY = 20;

    private static readonly MAX_CONSECUTIVE_FAILURE_RETRY = 5;
    private static readonly MAX_NO_PROGRESSION = 5;
    private static readonly DEFAULT_RETURN_DEQUEUED_ENTRIES = false;

    private readonly log: Logger;

    private returnDequeuedEntries = DequeueController.DEFAULT_RETURN_DEQUEUED_ENTRIES;
    private maxNumDequeue = DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE;

    private maxNumToReserve: () => number = () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE;
    private typesToDequeue: () => Set<string> = () => new Set<string>();
    private checkIsTypesToDequeue: (types: Set<string>) => boolean = () => true;

    private newReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;
    private retryReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;
    private fairnessReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;
    private timeoutReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>;

    private successReleaser?: (m: Map<K, SuccessDto<K, V, T>>) => Promise<Map<K, SuccessDto<K, V, T>>>;
    private failureReleaser?: (m: Map<K, FailureDto<K, V>>) => Promise<Map<K, FailureDto<K, V>>>;

    private onCompleted?: (m: Map<K, SuccessDto<K, V, T>>) => void;
    private onFailed?: (m: Map<K, FailureDto<K, V>>) => void;
    private onPreProcessingReserved?: (m: Map<K, V>) => Promise<Map<K, V>>;

    private constructor(logger: Logger = defaultLogger) {
        this.log = logger;
    }

    static create<K, V, T>(logger?: Logger): DequeueController<K, V, T> {
        return new DequeueController<K, V, T>(logger);
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
        this.retryReservator = retryReservator ?? undefined;
        return this;
    }

    onFairnessEntriesReserveDo(fairnessReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>): this {
        this.fairnessReservator = fairnessReservator ?? undefined;
        return this;
    }

    onTimeoutEntriesReserveDo(timeoutReservator?: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>): this {
        this.timeoutReservator = timeoutReservator ?? undefined;
        return this;
    }

    onReleaseEntriesDo(
        successReleaser: (m: Map<K, SuccessDto<K, V, T>>) => Promise<Map<K, SuccessDto<K, V, T>>>,
        failureReleaser: (m: Map<K, FailureDto<K, V>>) => Promise<Map<K, FailureDto<K, V>>>,
    ): this {
        this.successReleaser = requireNonNull(successReleaser);
        this.failureReleaser = requireNonNull(failureReleaser);
        return this;
    }

    onCompletedEntries(onCompleted?: (m: Map<K, SuccessDto<K, V, T>>) => void): this {
        this.onCompleted = onCompleted ?? undefined;
        return this;
    }

    onFailedEntries(onFailed?: (m: Map<K, FailureDto<K, V>>) => void): this {
        this.onFailed = onFailed ?? undefined;
        return this;
    }

    onPreProcessingReservedEntries(onPreProcessingReservedEntries?: (m: Map<K, V>) => Promise<Map<K, V>>): this {
        this.onPreProcessingReserved = onPreProcessingReservedEntries ?? undefined;
        return this;
    }

    async dequeueForCompute(
        computer: (key: K, value: V) => Promise<T>,
    ): Promise<Map<Reservator, Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>>> {
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
        const newReservator = requireNonNull(this.newReservator, 'newReservator is required');
        const successReleaser = requireNonNull(this.successReleaser, 'successReleaser is required');
        const failureReleaser = requireNonNull(this.failureReleaser, 'failureReleaser is required');

        const byReservator = new Map<
            Reservator,
            Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>
        >();

        byReservator.set(
            Reservator.NEW,
            await DequeueController.dequeueWithTypesAlgorithm<K, V, T>(
                this.maxNumDequeue,
                this.maxNumToReserve,
                this.typesToDequeue,
                this.returnDequeuedEntries,
                this.checkIsTypesToDequeue,
                newReservator,
                computer,
                successReleaser,
                failureReleaser,
                this.onCompleted,
                this.onFailed,
                this.onPreProcessingReserved,
                this.log,
            ),
        );

        byReservator.set(
            Reservator.RETRY,
            this.retryReservator
                ? await DequeueController.dequeueWithTypesAlgorithm<K, V, T>(
                    this.maxNumDequeue,
                    this.maxNumToReserve,
                    this.typesToDequeue,
                    this.returnDequeuedEntries,
                    this.checkIsTypesToDequeue,
                    this.retryReservator,
                    computer,
                    successReleaser,
                    failureReleaser,
                    this.onCompleted,
                    this.onFailed,
                    this.onPreProcessingReserved,
                    this.log,
                )
                : new Map(),
        );

        byReservator.set(
            Reservator.FAIRNESS,
            this.fairnessReservator
                ? await DequeueController.dequeueWithTypesAlgorithm<K, V, T>(
                    this.maxNumDequeue,
                    this.maxNumToReserve,
                    this.typesToDequeue,
                    this.returnDequeuedEntries,
                    this.checkIsTypesToDequeue,
                    this.fairnessReservator,
                    computer,
                    successReleaser,
                    failureReleaser,
                    this.onCompleted,
                    this.onFailed,
                    this.onPreProcessingReserved,
                    this.log,
                )
                : new Map(),
        );

        byReservator.set(
            Reservator.TIMEOUT,
            this.timeoutReservator
                ? await DequeueController.dequeueWithTypesAlgorithm(
                    this.maxNumDequeue,
                    this.maxNumToReserve,
                    this.typesToDequeue,
                    this.returnDequeuedEntries,
                    this.checkIsTypesToDequeue,
                    this.timeoutReservator,
                    computer,
                    successReleaser,
                    failureReleaser,
                    this.onCompleted,
                    this.onFailed,
                    this.onPreProcessingReserved,
                    this.log,
                )
                : new Map(),
        );

        return byReservator;
    }

    static async dequeueWithTypesAlgorithm<K, V, T>(
        maxNumDequeue: number,
        maxNumToReserve: () => number,
        typesToDequeue: () => Set<string>,
        returnDequeuedEntries: boolean,
        isWorkForTypes: (types: Set<string>) => boolean,
        reservator: (types: Set<string>, numToReserve: number) => Promise<Map<K, V>>,
        computer: (key: K, value: V) => Promise<T>,
        successReleaser: (m: Map<K, SuccessDto<K, V, T>>) => Promise<Map<K, SuccessDto<K, V, T>>>,
        failureReleaser: (m: Map<K, FailureDto<K, V>>) => Promise<Map<K, FailureDto<K, V>>>,
        onCompleted?: (m: Map<K, SuccessDto<K, V, T>>) => void,
        onFailed?: (m: Map<K, FailureDto<K, V>>) => void,
        onPreProcessingReservedEntries?: (m: Map<K, V>) => Promise<Map<K, V>>,
        log: Logger = defaultLogger,
    ): Promise<Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>> {
        let consecutiveFailureCounter = 0;
        let nonProgressionCounter = 0;
        let dequeuedCounter = 0;

        const allComputed = new Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>();

        while (isWorkForTypes(typesToDequeue()) && consecutiveFailureCounter < DequeueController.MAX_CONSECUTIVE_FAILURE_RETRY) {
            try {
                const numToReserve = maxNumToReserve();
                if (numToReserve <= 0) {
                    log.debug(`Number to reserve for ${Array.from(typesToDequeue()).join(',')} was ${numToReserve}. Returning.`);
                    return allComputed;
                }

                const reserved = await reservator(typesToDequeue(), numToReserve) ?? new Map<K, V>();
                const preProcessed =
                    onPreProcessingReservedEntries
                        ? await onPreProcessingReservedEntries(reserved)
                        : reserved;

                // Compute results
                const computed = new Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>();
                for (const [k, v] of preProcessed.entries()) {
                    try {
                        const computedValue = await computer(k, v);
                        computed.set(k, Either.ofRight(new SuccessDto(k, v, computedValue)));
                    } catch (e) {
                        const err = e instanceof Error ? e : new Error(String(e));
                        log.error(`Computer failed on dequeued key ${String(k)}.`, err);
                        computed.set(k, Either.ofLeft(new FailureDto(k, v, err)));
                    }
                }

                const folded = EitherCollectors.toMapFoldBoth(computed);
                const successByKey = folded.rightByKey;
                const failureByKey = folded.leftByKey;

                // success handling
                {
                    if (successByKey.size > 0) {
                        const released = await successReleaser(successByKey);
                        for (const [k, successDto] of released.entries()) {
                            computed.set(k, Either.ofRight(successDto));
                        }
                        nonProgressionCounter = 0;
                    } else {
                        nonProgressionCounter += 1;
                    }

                    if (successByKey.size > 0 || failureByKey.size === 0) {
                        if (onCompleted) {
                            onCompleted(EitherCollectors.toMapFoldRights(computed));
                        }
                    }
                }

                // failure handling
                {
                    if (failureByKey.size > 0) {
                        const released = await failureReleaser(failureByKey);
                        for (const [k, failureDto] of released.entries()) {
                            computed.set(k, Either.ofLeft(failureDto));
                        }

                        if (onFailed) {
                            onFailed(EitherCollectors.toMapFoldLefts(computed));
                        }

                        nonProgressionCounter = 0;
                    }
                }

                if (returnDequeuedEntries) {
                    for (const [k, v] of computed.entries()) {
                        allComputed.set(k, v);
                    }
                }

                // If reservator returns same elements over and over, count them
                {
                    dequeuedCounter += computed.size;

                    if (dequeuedCounter >= maxNumDequeue) {
                        log.debug(
                            `Dequeued ${allComputed.size} entries, dequeuedCounter ${dequeuedCounter} >= maxNumDequeue ${maxNumDequeue}. Returning ...`,
                        );
                        break;
                    }
                }

                if (nonProgressionCounter > DequeueController.MAX_NO_PROGRESSION) {
                    log.warn(`No progression (no success or failures) last ${nonProgressionCounter} times. Returning quietly.`);
                    break;
                }

                consecutiveFailureCounter = 0;

                if (computed.size === 0) {
                    // log.debug(`No more work to do on ${Array.from(typesToDequeue()).join(",")}. Returning.`);
                    return allComputed;
                }
            } catch (e) {
                const err = e instanceof Error ? e : new Error(String(e));
                log.error(`Exception caught while working on queue with these types: ${Array.from(typesToDequeue()).join(',')}`, err);
                consecutiveFailureCounter += 1;

                const ok = await DequeueController.backoffWithSleep(consecutiveFailureCounter, log);
                if (!ok) {
                    log.warn('Backoff with sleep interrupted, returning quietly.');
                    break;
                }
            }
        }

        if (consecutiveFailureCounter >= DequeueController.MAX_CONSECUTIVE_FAILURE_RETRY) {
            log.warn(`Dequeue experienced ${consecutiveFailureCounter} failures in a row. Giving up ...`);
        }

        return allComputed;
    }

    static async backoffWithSleep(failureCounter: number, log: Logger = defaultLogger): Promise<boolean> {
        try {
            const sleepSeconds = toExponentialBackoffSeconds(failureCounter);
            log.warn(`${failureCounter} attempt. Backoff sleeping ${sleepSeconds} secs`);
            await sleep(sleepSeconds * 1000);
            return true;
        } catch (e) {
            log.warn('Exception caught in backoff', e);
            return false;
        }
    }
}
