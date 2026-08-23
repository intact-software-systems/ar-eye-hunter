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
    readonly schedule?: (
        callback: () => void | Promise<void>,
        delayMs: number
    ) => RuntimeStateExpiryScheduledWork;
    readonly onError?: (error: Error) => void;
}

export interface RuntimeStateExpiryScheduledWork {
    cancel(): void;
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

export class RuntimeStateExpiryWorker {
    readonly firstRun: Promise<number>;

    private readonly firstRunDeferred = new Deferred<number>();
    private readonly repository: RuntimeStateExpiryRepository;
    private readonly intervalMs: number;
    private readonly excludedNamespaces: readonly string[];
    private readonly retryIntervalMs: number;
    private readonly schedule: NonNullable<RuntimeStateExpiryWorkerInput['schedule']>;
    private readonly onError: RuntimeStateExpiryWorkerInput['onError'];
    private stopped = false;
    private running = false;
    private scheduledWork: RuntimeStateExpiryScheduledWork | undefined;
    private failureCount = 0;
    private firstRunSettled = false;

    constructor(input: RuntimeStateExpiryWorkerInput) {
        this.repository = input.repository;
        this.intervalMs = input.intervalMs ?? RUNTIME_STATE_EXPIRY_EVICTION_INTERVAL_MS;
        this.excludedNamespaces = input.excludedNamespaces ?? [];
        this.retryIntervalMs = input.retryIntervalMs ??
            RUNTIME_STATE_EXPIRY_RETRY_INTERVAL_MS;
        this.schedule = input.schedule ?? scheduleRuntimeStateExpiry;
        this.onError = input.onError;
        validateExpiryWorkerDelay(this.intervalMs, 'interval');
        validateExpiryWorkerDelay(this.retryIntervalMs, 'retry interval');
        this.firstRun = this.firstRunDeferred.promise;
        void this.run();
    }

    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        if (this.scheduledWork !== undefined) {
            this.scheduledWork.cancel();
            this.scheduledWork = undefined;
        }
    }

    private scheduleRun(delayMs: number): void {
        if (this.stopped) {
            return;
        }
        this.scheduledWork = this.schedule(async () => {
            this.scheduledWork = undefined;
            await this.run();
        }, delayMs);
    }

    private async run(): Promise<void> {
        if (this.stopped || this.running) {
            return;
        }
        this.running = true;
        let failed = false;
        try {
            const removed = await evictExpiredRuntimeStateRows({
                repository: this.repository,
                excludedNamespaces: this.excludedNamespaces
            });
            this.failureCount = 0;
            if (!this.firstRunSettled) {
                this.firstRunSettled = true;
                this.firstRunDeferred.resolve(removed);
            }
        }
        catch (caught) {
            failed = true;
            this.failureCount += 1;
            const error = toError(caught);
            if (!this.firstRunSettled) {
                this.firstRunSettled = true;
                this.firstRunDeferred.reject(error);
            }
            try {
                this.onError?.(error);
            }
            catch {
                // Observability must not disable generic expiry ownership.
            }
        }
        finally {
            this.running = false;
            if (!this.stopped) {
                this.scheduleRun(failed ? this.nextRetryDelay() : this.intervalMs);
            }
        }
    }

    private nextRetryDelay(): number {
        return Math.min(
            this.retryIntervalMs * 2 ** Math.min(this.failureCount - 1, 1),
            RUNTIME_STATE_EXPIRY_MAXIMUM_RETRY_INTERVAL_MS
        );
    }
}

function scheduleRuntimeStateExpiry(
    callback: () => void | Promise<void>,
    delayMs: number
): RuntimeStateExpiryScheduledWork {
    const handle = setTimeout(() => void callback(), delayMs);
    unrefScheduleHandle(handle);
    return { cancel: () => clearTimeout(handle) };
}

function unrefScheduleHandle(handle: number | object): void {
    if (typeof handle === 'object' && 'unref' in handle) {
        const unref = handle.unref;
        if (typeof unref === 'function') {
            unref.call(handle);
        }
    }
}

function validateExpiryWorkerDelay(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`Runtime state expiry ${label} is invalid`);
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
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
