export type NativeIndexedDbRequestOperation = 'get' | 'put';
export type NativeIndexedDbRequestOutcome = 'success' | 'error';
export type NativeIndexedDbTransactionOutcome = 'complete' | 'abort';

export interface NativeIndexedDbRequestTimingSample {
    readonly kind: 'request';
    readonly transactionId: number;
    readonly storeName: string;
    readonly operation: NativeIndexedDbRequestOperation;
    readonly outcome: NativeIndexedDbRequestOutcome;
    readonly startedAtMs: number;
    readonly durationMs: number;
}

export interface NativeIndexedDbTransactionTimingSample {
    readonly kind: 'transaction';
    readonly transactionId: number;
    readonly storeNames: readonly string[];
    readonly mode: IDBTransactionMode;
    readonly outcome: NativeIndexedDbTransactionOutcome;
    readonly requestCount: number;
    readonly successfulRequestCount: number;
    readonly cursorRequestCount: number;
    readonly cursorIterationCount: number;
    readonly startedAtMs: number;
    readonly durationMs: number;
}

export type NativeIndexedDbTimingSample =
    | NativeIndexedDbRequestTimingSample
    | NativeIndexedDbTransactionTimingSample;

export interface NativeIndexedDbRequestTimingSummary {
    readonly operation: NativeIndexedDbRequestOperation;
    readonly outcome: NativeIndexedDbRequestOutcome;
    readonly sampleCount: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
    readonly maxMs: number;
}

export interface NativeIndexedDbTransactionTimingSummary {
    readonly storeNames: readonly string[];
    readonly mode: IDBTransactionMode;
    readonly outcome: NativeIndexedDbTransactionOutcome;
    readonly sampleCount: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
    readonly maxMs: number;
}

export interface NativeIndexedDbTimingSnapshot {
    readonly sampleCapacity: number;
    readonly samples: readonly NativeIndexedDbTimingSample[];
    readonly droppedSampleCount: number;
    readonly transactionOutcomes: readonly NativeIndexedDbTransactionOutcome[];
    readonly successfulPutInAbortedTransaction: boolean;
    readonly cursorRequestCount: number;
    readonly cursorIterationCount: number;
    readonly totalIssuedRequestCount: number;
    readonly requestSummaries: readonly NativeIndexedDbRequestTimingSummary[];
    readonly transactionSummaries: readonly NativeIndexedDbTransactionTimingSummary[];
}

interface NativeIndexedDbTransactionState {
    readonly transactionId: number;
    readonly storeNames: readonly string[];
    readonly mode: IDBTransactionMode;
    readonly startedAtMs: number;
    requestCount: number;
    successfulRequestCount: number;
    successfulPutCount: number;
    cursorRequestCount: number;
    cursorIterationCount: number;
}

export class NativeIndexedDbTimingRecorder {
    readonly #sampleCapacity: number;
    readonly #samples: NativeIndexedDbTimingSample[] = [];
    readonly #transactions = new WeakMap<IDBTransaction, NativeIndexedDbTransactionState>();
    readonly #transactionOutcomes = new Set<NativeIndexedDbTransactionOutcome>();
    readonly #originalTransaction = IDBDatabase.prototype.transaction;
    readonly #originalGet = IDBObjectStore.prototype.get;
    readonly #originalPut = IDBObjectStore.prototype.put;
    readonly #originalOpenCursor = IDBObjectStore.prototype.openCursor;
    readonly #originalDelete = IDBObjectStore.prototype.delete;
    readonly #originalGetAll = IDBObjectStore.prototype.getAll;
    readonly #originalIndexOpenCursor = IDBIndex.prototype.openCursor;
    #droppedSampleCount = 0;
    #nextTransactionId = 1;
    #successfulPutInAbortedTransaction = false;
    #cursorRequestCount = 0;
    #cursorIterationCount = 0;
    #totalIssuedRequestCount = 0;
    #recording = false;

    constructor(sampleCapacity: number) {
        if (!Number.isSafeInteger(sampleCapacity) || sampleCapacity < 1) {
            throw new RangeError('Native IndexedDB timing sample capacity must be a positive safe integer');
        }
        this.#sampleCapacity = sampleCapacity;
    }

    start(): void {
        if (this.#recording) {
            return;
        }
        this.#recording = true;
        this.installTransactionObservation();
        this.installRequestObservation();
    }

    stop(): void {
        if (!this.#recording) {
            return;
        }
        IDBDatabase.prototype.transaction = this.#originalTransaction;
        IDBObjectStore.prototype.get = this.#originalGet;
        IDBObjectStore.prototype.put = this.#originalPut;
        IDBObjectStore.prototype.openCursor = this.#originalOpenCursor;
        IDBObjectStore.prototype.delete = this.#originalDelete;
        IDBObjectStore.prototype.getAll = this.#originalGetAll;
        IDBIndex.prototype.openCursor = this.#originalIndexOpenCursor;
        this.#recording = false;
    }

    get methodsRestored(): boolean {
        return IDBDatabase.prototype.transaction === this.#originalTransaction &&
            IDBObjectStore.prototype.get === this.#originalGet &&
            IDBObjectStore.prototype.put === this.#originalPut &&
            IDBObjectStore.prototype.openCursor === this.#originalOpenCursor &&
            IDBObjectStore.prototype.delete === this.#originalDelete &&
            IDBObjectStore.prototype.getAll === this.#originalGetAll &&
            IDBIndex.prototype.openCursor === this.#originalIndexOpenCursor;
    }

    snapshot(): NativeIndexedDbTimingSnapshot {
        return {
            sampleCapacity: this.#sampleCapacity,
            samples: [...this.#samples],
            droppedSampleCount: this.#droppedSampleCount,
            transactionOutcomes: [...this.#transactionOutcomes],
            successfulPutInAbortedTransaction: this.#successfulPutInAbortedTransaction,
            cursorRequestCount: this.#cursorRequestCount,
            cursorIterationCount: this.#cursorIterationCount,
            totalIssuedRequestCount: this.#totalIssuedRequestCount,
            requestSummaries: computeNativeIndexedDbRequestSummaries(this.#samples),
            transactionSummaries: computeNativeIndexedDbTransactionSummaries(this.#samples)
        };
    }

    private installTransactionObservation(): void {
        const recorder = this;
        const original = this.#originalTransaction;
        IDBDatabase.prototype.transaction = function (
            this: IDBDatabase,
            storeNames: string | string[],
            mode?: IDBTransactionMode,
            options?: IDBTransactionOptions
        ): IDBTransaction {
            const transaction = options === undefined
                ? original.call(this, storeNames, mode)
                : original.call(this, storeNames, mode, options);
            recorder.observeTransaction(transaction);
            return transaction;
        } as typeof IDBDatabase.prototype.transaction;
    }

    private installRequestObservation(): void {
        const recorder = this;
        const originalGet = this.#originalGet;
        IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
            const startedAtMs = performance.now();
            const request = originalGet.call(this, query);
            recorder.observeRequest(this, request, 'get', startedAtMs);
            return request;
        } as typeof IDBObjectStore.prototype.get;

        const originalPut = this.#originalPut;
        IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
            const startedAtMs = performance.now();
            const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
            recorder.observeRequest(this, request, 'put', startedAtMs);
            return request;
        } as typeof IDBObjectStore.prototype.put;

        const originalOpenCursor = this.#originalOpenCursor;
        IDBObjectStore.prototype.openCursor = function (
            this: IDBObjectStore,
            query?: IDBValidKey | IDBKeyRange | null,
            direction?: IDBCursorDirection
        ) {
            const request = originalOpenCursor.call(this, query, direction);
            recorder.observeCursor(this, request);
            return request;
        } as typeof IDBObjectStore.prototype.openCursor;

        const originalDelete = this.#originalDelete;
        IDBObjectStore.prototype.delete = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
            const request = originalDelete.call(this, query);
            recorder.observeUntimedRequest(this.transaction, request);
            return request;
        } as typeof IDBObjectStore.prototype.delete;

        const originalGetAll = this.#originalGetAll;
        IDBObjectStore.prototype.getAll = function (
            this: IDBObjectStore,
            query?: IDBValidKey | IDBKeyRange | null,
            count?: number
        ) {
            const request = count === undefined
                ? originalGetAll.call(this, query)
                : originalGetAll.call(this, query, count);
            recorder.observeUntimedRequest(this.transaction, request);
            return request;
        } as typeof IDBObjectStore.prototype.getAll;

        const originalIndexOpenCursor = this.#originalIndexOpenCursor;
        IDBIndex.prototype.openCursor = function (
            this: IDBIndex,
            query?: IDBValidKey | IDBKeyRange | null,
            direction?: IDBCursorDirection
        ) {
            const request = originalIndexOpenCursor.call(this, query, direction);
            recorder.observeCursor(this.objectStore, request);
            return request;
        } as typeof IDBIndex.prototype.openCursor;
    }

    private observeTransaction(transaction: IDBTransaction): void {
        const state: NativeIndexedDbTransactionState = {
            transactionId: this.#nextTransactionId,
            storeNames: [...transaction.objectStoreNames],
            mode: transaction.mode,
            startedAtMs: performance.now(),
            requestCount: 0,
            successfulRequestCount: 0,
            successfulPutCount: 0,
            cursorRequestCount: 0,
            cursorIterationCount: 0
        };
        this.#nextTransactionId += 1;
        this.#transactions.set(transaction, state);
        transaction.addEventListener('complete', () => this.recordTransaction(state, 'complete'), { once: true });
        transaction.addEventListener('abort', () => this.recordTransaction(state, 'abort'), { once: true });
    }

    private observeRequest(
        store: IDBObjectStore,
        request: IDBRequest,
        operation: NativeIndexedDbRequestOperation,
        startedAtMs: number
    ): void {
        const state = this.requireTransactionState(store.transaction);
        state.requestCount += 1;
        this.#totalIssuedRequestCount += 1;
        request.addEventListener('success', () => {
            state.successfulRequestCount += 1;
            if (operation === 'put') {
                state.successfulPutCount += 1;
            }
            this.recordSample({
                kind: 'request',
                transactionId: state.transactionId,
                storeName: store.name,
                operation,
                outcome: 'success',
                startedAtMs,
                durationMs: performance.now() - startedAtMs
            });
        }, { once: true });
        request.addEventListener('error', () => {
            this.recordSample({
                kind: 'request',
                transactionId: state.transactionId,
                storeName: store.name,
                operation,
                outcome: 'error',
                startedAtMs,
                durationMs: performance.now() - startedAtMs
            });
        }, { once: true });
    }

    private observeCursor(store: IDBObjectStore, request: IDBRequest<IDBCursorWithValue | null>): void {
        const state = this.requireTransactionState(store.transaction);
        state.requestCount += 1;
        state.cursorRequestCount += 1;
        this.#totalIssuedRequestCount += 1;
        this.#cursorRequestCount += 1;
        let requestSucceeded = false;
        request.addEventListener('success', () => {
            if (!requestSucceeded) {
                state.successfulRequestCount += 1;
                requestSucceeded = true;
            }
            if (request.result !== null) {
                state.cursorIterationCount += 1;
                this.#cursorIterationCount += 1;
            }
        });
    }

    private observeUntimedRequest(transaction: IDBTransaction, request: IDBRequest): void {
        const state = this.requireTransactionState(transaction);
        state.requestCount += 1;
        this.#totalIssuedRequestCount += 1;
        request.addEventListener('success', () => {
            state.successfulRequestCount += 1;
        }, { once: true });
    }

    private requireTransactionState(transaction: IDBTransaction): NativeIndexedDbTransactionState {
        const state = this.#transactions.get(transaction);
        if (state === undefined) {
            throw new Error('IndexedDB request was issued from an unobserved transaction');
        }
        return state;
    }

    private recordTransaction(
        state: NativeIndexedDbTransactionState,
        outcome: NativeIndexedDbTransactionOutcome
    ): void {
        this.#transactionOutcomes.add(outcome);
        if (outcome === 'abort' && state.successfulPutCount > 0) {
            this.#successfulPutInAbortedTransaction = true;
        }
        this.recordSample({
            kind: 'transaction',
            transactionId: state.transactionId,
            storeNames: state.storeNames,
            mode: state.mode,
            outcome,
            requestCount: state.requestCount,
            successfulRequestCount: state.successfulRequestCount,
            cursorRequestCount: state.cursorRequestCount,
            cursorIterationCount: state.cursorIterationCount,
            startedAtMs: state.startedAtMs,
            durationMs: performance.now() - state.startedAtMs
        });
    }

    private recordSample(sample: NativeIndexedDbTimingSample): void {
        if (this.#samples.length < this.#sampleCapacity) {
            this.#samples.push(sample);
            return;
        }
        this.#droppedSampleCount += 1;
    }
}

function computeNativeIndexedDbRequestSummaries(
    samples: readonly NativeIndexedDbTimingSample[]
): readonly NativeIndexedDbRequestTimingSummary[] {
    const groups = new Map<string, {
        operation: NativeIndexedDbRequestOperation;
        outcome: NativeIndexedDbRequestOutcome;
        durations: number[];
    }>();
    for (const sample of samples) {
        if (sample.kind !== 'request') {
            continue;
        }
        const key = `${sample.operation}:${sample.outcome}`;
        const group = groups.get(key) ?? { operation: sample.operation, outcome: sample.outcome, durations: [] };
        group.durations.push(sample.durationMs);
        groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({
        operation: group.operation,
        outcome: group.outcome,
        ...toNativeDurationSummary(group.durations)
    }));
}

function computeNativeIndexedDbTransactionSummaries(
    samples: readonly NativeIndexedDbTimingSample[]
): readonly NativeIndexedDbTransactionTimingSummary[] {
    const groups = new Map<string, {
        storeNames: readonly string[];
        mode: IDBTransactionMode;
        outcome: NativeIndexedDbTransactionOutcome;
        durations: number[];
    }>();
    for (const sample of samples) {
        if (sample.kind !== 'transaction') {
            continue;
        }
        const key = JSON.stringify([sample.storeNames, sample.mode, sample.outcome]);
        const group = groups.get(key) ?? {
            storeNames: sample.storeNames,
            mode: sample.mode,
            outcome: sample.outcome,
            durations: []
        };
        group.durations.push(sample.durationMs);
        groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({
        storeNames: group.storeNames,
        mode: group.mode,
        outcome: group.outcome,
        ...toNativeDurationSummary(group.durations)
    }));
}

function toNativeDurationSummary(durations: readonly number[]) {
    const sorted = [...durations].sort((left, right) => left - right);
    return {
        sampleCount: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        maxMs: sorted[sorted.length - 1]
    };
}

function percentile(sortedValues: readonly number[], fraction: number): number {
    return sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)];
}
