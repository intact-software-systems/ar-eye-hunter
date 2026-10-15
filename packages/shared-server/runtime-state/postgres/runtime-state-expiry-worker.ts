import { startRepeating } from '@shared/resilience/repeating-run.ts';
import { createDefaultBackgroundTimers, type Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';

const RUNTIME_STATE_EXPIRY_EVICTION_INTERVAL_MS = 60_000;
const RUNTIME_STATE_EXPIRY_RETRY_INTERVAL_MS = 10_000;
const RUNTIME_STATE_EXPIRY_MAXIMUM_RETRY_INTERVAL_MS = 20_000;

export interface RuntimeStateExpiryRepository {
    deleteAllExpired(excludedNamespaces: readonly string[]): Promise<number>;
}

export interface RuntimeStateExpiryWorkerInput {
    readonly repository: RuntimeStateExpiryRepository;
    readonly intervalMs?: number;
    readonly excludedNamespaces?: readonly string[];
    readonly retryIntervalMs?: number;
    readonly timers?: Timers;
    readonly onError?: (error: Error) => void;
}

export interface EvictExpiredRuntimeStateRowsInput {
    readonly repository: RuntimeStateExpiryRepository;
    readonly excludedNamespaces?: readonly string[];
}

export async function evictExpiredRuntimeStateRows(
    input: EvictExpiredRuntimeStateRowsInput
): Promise<number> {
    const removed = await input.repository.deleteAllExpired(
        input.excludedNamespaces ?? []
    );
    if (removed > 0) {
        console.log(`Evicted expired runtime_state_store rows: ${removed}`);
    }
    return removed;
}

/** Evicts at once and then every interval; a failed eviction retries after the retry interval, doubled once, at most. */
export class RuntimeStateExpiryWorker {
    readonly firstRun: Promise<number>;

    private readonly firstRunDeferred = new Deferred<number>();
    private readonly repository: RuntimeStateExpiryRepository;
    private readonly excludedNamespaces: readonly string[];
    private readonly onError: RuntimeStateExpiryWorkerInput['onError'];
    private readonly stopRepeating: () => void;
    private firstRunSettled = false;

    constructor(input: RuntimeStateExpiryWorkerInput) {
        this.repository = input.repository;
        this.excludedNamespaces = input.excludedNamespaces ?? [];
        this.onError = input.onError;
        const intervalMs = input.intervalMs ?? RUNTIME_STATE_EXPIRY_EVICTION_INTERVAL_MS;
        const retryIntervalMs = input.retryIntervalMs ?? RUNTIME_STATE_EXPIRY_RETRY_INTERVAL_MS;
        validateExpiryWorkerDelay(intervalMs, 'interval');
        validateExpiryWorkerDelay(retryIntervalMs, 'retry interval');
        this.firstRun = this.firstRunDeferred.promise;
        this.stopRepeating = startRepeating({
            timers: input.timers ?? createDefaultBackgroundTimers(),
            intervalMs,
            retryBackoff: {
                baseMs: retryIntervalMs,
                maxMs: Math.min(retryIntervalMs * 2, RUNTIME_STATE_EXPIRY_MAXIMUM_RETRY_INTERVAL_MS)
            },
            firstRun: 'now',
            run: () => this.evict()
        });
    }

    stop(): void {
        this.stopRepeating();
    }

    private async evict(): Promise<void> {
        try {
            const removed = await evictExpiredRuntimeStateRows({
                repository: this.repository,
                excludedNamespaces: this.excludedNamespaces
            });
            this.settleFirstRun(() => this.firstRunDeferred.resolve(removed));
        }
        catch (caught) {
            const error = toError(caught);
            this.settleFirstRun(() => this.firstRunDeferred.reject(error));
            try {
                this.onError?.(error);
            }
            catch {
                // Observability must not disable generic expiry ownership.
            }
            throw error;
        }
    }

    private settleFirstRun(settle: () => void): void {
        if (this.firstRunSettled) {
            return;
        }
        this.firstRunSettled = true;
        settle();
    }
}

function validateExpiryWorkerDelay(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`Runtime state expiry ${label} is invalid`);
    }
}

class Deferred<T> {
    readonly promise: Promise<T>;

    private resolvePromise: ((value: T) => void) | undefined;
    private rejectPromise: ((error: Error) => void) | undefined;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolvePromise = resolve;
            this.rejectPromise = reject;
        });
    }

    resolve(value: T): void {
        const resolve = this.resolvePromise;
        if (resolve === undefined) {
            throw new Error('Deferred promise resolve function is unavailable');
        }
        resolve(value);
    }

    reject(error: Error): void {
        const reject = this.rejectPromise;
        if (reject === undefined) {
            throw new Error('Deferred promise reject function is unavailable');
        }
        reject(error);
    }
}
