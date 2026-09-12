export type NativeIndexedDbRequestOperation = 'get' | 'put';
export type NativeIndexedDbRequestOutcome = 'success' | 'error';
export type NativeIndexedDbTransactionOutcome = 'complete' | 'abort';

export interface NativeIndexedDbRequestTimingSample {
    readonly kind: 'request';
    readonly databaseName: string;
    readonly transactionId: number;
    readonly storeName: string;
    readonly operation: NativeIndexedDbRequestOperation;
    readonly outcome: NativeIndexedDbRequestOutcome;
    readonly startedAtMs: number;
    readonly durationMs: number;
}

export interface NativeIndexedDbTransactionTimingSample {
    readonly kind: 'transaction';
    readonly databaseName: string;
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
    readonly databaseName: string;
    readonly operation: NativeIndexedDbRequestOperation;
    readonly outcome: NativeIndexedDbRequestOutcome;
    readonly sampleCount: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
    readonly maxMs: number;
}

export interface NativeIndexedDbTransactionTimingSummary {
    readonly databaseName: string;
    readonly storeNames: readonly string[];
    readonly mode: IDBTransactionMode;
    readonly outcome: NativeIndexedDbTransactionOutcome;
    readonly sampleCount: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
    readonly maxMs: number;
}

interface NativeIndexedDbDurationSummary {
    readonly sampleCount: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
    readonly maxMs: number;
}

export interface NativeIndexedDbTimingSnapshot {
    readonly sampleCapacity: number;
    readonly samples: readonly NativeIndexedDbTimingSample[];
    readonly capturedDatabaseNames: readonly string[];
    readonly droppedSampleCount: number;
    readonly uncapturedInFlightObservationCount: number;
    readonly uncapturedPreCaptureRequestCount: number;
    readonly transactionOutcomes: readonly NativeIndexedDbTransactionOutcome[];
    readonly successfulPutInAbortedTransaction: boolean;
    readonly cursorRequestCount: number;
    readonly cursorIterationCount: number;
    readonly totalIssuedRequestCount: number;
    readonly requestSummaries: readonly NativeIndexedDbRequestTimingSummary[];
    readonly transactionSummaries: readonly NativeIndexedDbTransactionTimingSummary[];
}

export interface NativeIndexedDbTimingSemanticsProbe extends NativeIndexedDbTimingSnapshot {
    readonly durableCommittedValue: string | undefined;
    readonly durableAbortedValue: string | undefined;
    readonly structuredCloneLabel: string | undefined;
    readonly structuredCloneValues: readonly number[];
    readonly synchronousPutErrorName: string | null;
    readonly methodsRestored: boolean;
}

export interface NativeIndexedDbTimingDisposalProbe {
    readonly samplesAtStop: number;
    readonly samplesAfterCompletion: number;
    readonly uncapturedInFlightObservationCount: number;
    readonly durableValue: string | undefined;
    readonly methodsRestored: boolean;
}

export interface NativeIndexedDbTimingPreCaptureTransactionProbe {
    readonly operationResult: 'returned' | 'threw';
    readonly operationError: string | null;
    readonly transactionOutcome: 'complete' | 'abort';
    readonly durableValue: string | undefined;
    readonly uncapturedPreCaptureRequestCount: number;
    readonly methodsRestored: boolean;
}

export interface NativeIndexedDbTimingDatabaseFilterProbe extends NativeIndexedDbTimingSnapshot {
    readonly includedDatabaseName: string;
    readonly excludedDatabaseName: string;
    readonly methodsRestored: boolean;
}

export interface NativeIndexedDbTimingFailureCleanupProbe {
    readonly probeRejected: boolean;
    readonly databaseDeleted: boolean;
}

interface NativeIndexedDbTransactionState {
    readonly captureGeneration: number;
    readonly databaseName: string;
    readonly transactionId: number;
    readonly storeNames: readonly string[];
    readonly mode: IDBTransactionMode;
    readonly startedAtMs: number;
    requestCount: number;
    successfulRequestCount: number;
    successfulPutCount: number;
    cursorRequestCount: number;
    cursorIterationCount: number;
    readonly cursorObservationCancellations: Set<() => void>;
}

export class NativeIndexedDbTimingRecorder {
    readonly #sampleCapacity: number;
    readonly #databaseName: string | undefined;
    readonly #samples: NativeIndexedDbTimingSample[] = [];
    readonly #transactions = new WeakMap<IDBTransaction, NativeIndexedDbTransactionState>();
    readonly #excludedTransactions = new WeakSet<IDBTransaction>();
    readonly #transactionOutcomes = new Set<NativeIndexedDbTransactionOutcome>();
    readonly #activeObservationCancellations = new Set<() => void>();
    readonly #originalTransaction = IDBDatabase.prototype.transaction;
    readonly #originalGet = IDBObjectStore.prototype.get;
    readonly #originalPut = IDBObjectStore.prototype.put;
    readonly #originalOpenCursor = IDBObjectStore.prototype.openCursor;
    readonly #originalDelete = IDBObjectStore.prototype.delete;
    readonly #originalGetAll = IDBObjectStore.prototype.getAll;
    readonly #originalIndexOpenCursor = IDBIndex.prototype.openCursor;
    #droppedSampleCount = 0;
    #uncapturedInFlightObservationCount = 0;
    #uncapturedPreCaptureRequestCount = 0;
    #nextTransactionId = 1;
    #captureGeneration = 0;
    #successfulPutInAbortedTransaction = false;
    #cursorRequestCount = 0;
    #cursorIterationCount = 0;
    #totalIssuedRequestCount = 0;
    #recording = false;

    constructor(sampleCapacity: number, databaseName?: string) {
        if (!Number.isSafeInteger(sampleCapacity) || sampleCapacity < 1) {
            throw new RangeError('Native IndexedDB timing sample capacity must be a positive safe integer');
        }
        if (databaseName !== undefined && databaseName.length === 0) {
            throw new RangeError('Native IndexedDB timing database name must not be empty');
        }
        this.#sampleCapacity = sampleCapacity;
        this.#databaseName = databaseName;
    }

    start(): void {
        if (this.#recording) {
            return;
        }
        this.#captureGeneration += 1;
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
        const inFlight = [...this.#activeObservationCancellations];
        this.#uncapturedInFlightObservationCount += inFlight.length;
        for (const cancel of inFlight) {
            cancel();
        }
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
            capturedDatabaseNames: [...new Set(this.#samples.map((sample) => sample.databaseName))].sort(),
            droppedSampleCount: this.#droppedSampleCount,
            uncapturedInFlightObservationCount: this.#uncapturedInFlightObservationCount,
            uncapturedPreCaptureRequestCount: this.#uncapturedPreCaptureRequestCount,
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
        this.installTimedRequestObservation();
        this.installObjectStoreInventoryObservation();
        this.installIndexCursorObservation();
    }

    private installTimedRequestObservation(): void {
        const recorder = this;
        const originalGet = this.#originalGet;
        IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
            const startedAtMs = performance.now();
            const request = originalGet.call(this, query);
            recorder.observeRequest({ store: this, request, operation: 'get', startedAtMs });
            return request;
        } as typeof IDBObjectStore.prototype.get;

        const originalPut = this.#originalPut;
        IDBObjectStore.prototype.put = function (
            this: IDBObjectStore,
            value: Parameters<IDBObjectStore['put']>[0],
            key?: IDBValidKey
        ) {
            const startedAtMs = performance.now();
            const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
            recorder.observeRequest({ store: this, request, operation: 'put', startedAtMs });
            return request;
        } as typeof IDBObjectStore.prototype.put;
    }

    private installObjectStoreInventoryObservation(): void {
        const recorder = this;
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
    }

    private installIndexCursorObservation(): void {
        const recorder = this;
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
        if (this.#databaseName !== undefined && transaction.db.name !== this.#databaseName) {
            this.#excludedTransactions.add(transaction);
            return;
        }
        const state: NativeIndexedDbTransactionState = {
            captureGeneration: this.#captureGeneration,
            databaseName: transaction.db.name,
            transactionId: this.#nextTransactionId,
            storeNames: [...transaction.objectStoreNames],
            mode: transaction.mode,
            startedAtMs: performance.now(),
            requestCount: 0,
            successfulRequestCount: 0,
            successfulPutCount: 0,
            cursorRequestCount: 0,
            cursorIterationCount: 0,
            cursorObservationCancellations: new Set()
        };
        this.#nextTransactionId += 1;
        this.#transactions.set(transaction, state);
        let cancel = () => {};
        const complete = () => {
            cancel();
            this.finishCursorObservations(state);
            this.recordTransaction(state, 'complete');
        };
        const abort = () => {
            cancel();
            this.finishCursorObservations(state);
            this.recordTransaction(state, 'abort');
        };
        transaction.addEventListener('complete', complete, { once: true });
        transaction.addEventListener('abort', abort, { once: true });
        cancel = this.trackObservation(() => {
            transaction.removeEventListener('complete', complete);
            transaction.removeEventListener('abort', abort);
        });
    }

    private observeRequest(
        input: Readonly<{
            store: IDBObjectStore;
            request: IDBRequest;
            operation: NativeIndexedDbRequestOperation;
            startedAtMs: number;
        }>
    ): void {
        const { store, request, operation, startedAtMs } = input;
        const state = this.findCapturedTransaction(store.transaction);
        if (state === undefined) {
            return;
        }
        this.#totalIssuedRequestCount += 1;
        state.requestCount += 1;
        let cancel = () => {};
        const success = () => {
            cancel();
            state.successfulRequestCount += 1;
            if (operation === 'put') {
                state.successfulPutCount += 1;
            }
            this.recordSample({
                kind: 'request',
                databaseName: state.databaseName,
                transactionId: state.transactionId,
                storeName: store.name,
                operation,
                outcome: 'success',
                startedAtMs,
                durationMs: performance.now() - startedAtMs
            });
        };
        const failure = () => {
            cancel();
            this.recordSample({
                kind: 'request',
                databaseName: state.databaseName,
                transactionId: state.transactionId,
                storeName: store.name,
                operation,
                outcome: 'error',
                startedAtMs,
                durationMs: performance.now() - startedAtMs
            });
        };
        request.addEventListener('success', success, { once: true });
        request.addEventListener('error', failure, { once: true });
        cancel = this.trackObservation(() => {
            request.removeEventListener('success', success);
            request.removeEventListener('error', failure);
        });
    }

    private observeCursor(store: IDBObjectStore, request: IDBRequest<IDBCursorWithValue | null>): void {
        const state = this.findCapturedTransaction(store.transaction);
        if (state === undefined) {
            return;
        }
        this.#totalIssuedRequestCount += 1;
        this.#cursorRequestCount += 1;
        state.requestCount += 1;
        state.cursorRequestCount += 1;
        let requestSucceeded = false;
        let cancel = () => {};
        const success = () => {
            if (!requestSucceeded) {
                state.successfulRequestCount += 1;
                requestSucceeded = true;
            }
            if (request.result !== null) {
                state.cursorIterationCount += 1;
                this.#cursorIterationCount += 1;
            }
        };
        const cancelOnError = () => cancel();
        request.addEventListener('success', success);
        request.addEventListener('error', cancelOnError, { once: true });
        const trackedCancel = this.trackObservation(() => {
            request.removeEventListener('success', success);
            request.removeEventListener('error', cancelOnError);
        });
        cancel = () => {
            trackedCancel();
            state.cursorObservationCancellations.delete(cancel);
        };
        state.cursorObservationCancellations.add(cancel);
    }

    private observeUntimedRequest(transaction: IDBTransaction, request: IDBRequest): void {
        const state = this.findCapturedTransaction(transaction);
        if (state === undefined) {
            return;
        }
        this.#totalIssuedRequestCount += 1;
        state.requestCount += 1;
        let cancel = () => {};
        const success = () => {
            cancel();
            state.successfulRequestCount += 1;
        };
        const cancelOnError = () => cancel();
        request.addEventListener('success', success, { once: true });
        request.addEventListener('error', cancelOnError, { once: true });
        cancel = this.trackObservation(() => {
            request.removeEventListener('success', success);
            request.removeEventListener('error', cancelOnError);
        });
    }

    private findCapturedTransaction(transaction: IDBTransaction): NativeIndexedDbTransactionState | undefined {
        if (this.#excludedTransactions.has(transaction)) {
            return undefined;
        }
        const state = this.#transactions.get(transaction);
        if (state === undefined || state.captureGeneration !== this.#captureGeneration) {
            this.#uncapturedPreCaptureRequestCount += 1;
            return undefined;
        }
        return state;
    }

    private finishCursorObservations(state: NativeIndexedDbTransactionState): void {
        for (const cancel of [...state.cursorObservationCancellations]) {
            cancel();
        }
    }

    private trackObservation(removeListeners: () => void): () => void {
        let active = true;
        const cancel = () => {
            if (!active) {
                return;
            }
            active = false;
            removeListeners();
            this.#activeObservationCancellations.delete(cancel);
        };
        this.#activeObservationCancellations.add(cancel);
        return cancel;
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
            databaseName: state.databaseName,
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
        databaseName: string;
        operation: NativeIndexedDbRequestOperation;
        outcome: NativeIndexedDbRequestOutcome;
        durations: number[];
    }>();
    for (const sample of samples) {
        if (sample.kind !== 'request') {
            continue;
        }
        const key = `${sample.databaseName}:${sample.operation}:${sample.outcome}`;
        const group = groups.get(key) ?? {
            databaseName: sample.databaseName,
            operation: sample.operation,
            outcome: sample.outcome,
            durations: []
        };
        group.durations.push(sample.durationMs);
        groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({
        operation: group.operation,
        outcome: group.outcome,
        databaseName: group.databaseName,
        ...toNativeDurationSummary(group.durations)
    }));
}

function computeNativeIndexedDbTransactionSummaries(
    samples: readonly NativeIndexedDbTimingSample[]
): readonly NativeIndexedDbTransactionTimingSummary[] {
    const groups = new Map<string, {
        databaseName: string;
        storeNames: readonly string[];
        mode: IDBTransactionMode;
        outcome: NativeIndexedDbTransactionOutcome;
        durations: number[];
    }>();
    for (const sample of samples) {
        if (sample.kind !== 'transaction') {
            continue;
        }
        const key = JSON.stringify([sample.databaseName, sample.storeNames, sample.mode, sample.outcome]);
        const group = groups.get(key) ?? {
            databaseName: sample.databaseName,
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
        databaseName: group.databaseName,
        mode: group.mode,
        outcome: group.outcome,
        ...toNativeDurationSummary(group.durations)
    }));
}

function toNativeDurationSummary(durations: readonly number[]): NativeIndexedDbDurationSummary {
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

export async function runNativeIndexedDbTimingSemanticsProbe(
    databaseId: string
): Promise<NativeIndexedDbTimingSemanticsProbe> {
    const database = await openProbeDatabase(`playwright-indexeddb-timing-${databaseId}`);
    const recorder = new NativeIndexedDbTimingRecorder(3);
    try {
        recorder.start();
        let synchronousPutErrorName: string | null = null;
        await writeProbeValue(database, 'committed', 'committed');
        await writeStructuredCloneProbeValue(database);
        synchronousPutErrorName = await observeInvalidPutError(database);
        await writeThenAbortProbeValue(database, 'aborted', 'aborted');
        await readFirstProbeCursor(database);
        await exerciseProbeRequestInventory(database);
        recorder.stop();
        return {
            ...recorder.snapshot(),
            durableCommittedValue: await readProbeValue(database, 'committed'),
            durableAbortedValue: await readProbeValue(database, 'aborted'),
            ...await readStructuredCloneProbeValue(database),
            synchronousPutErrorName,
            methodsRestored: recorder.methodsRestored
        };
    }
    finally {
        recorder.stop();
        database.close();
    }
}

export async function runNativeIndexedDbTimingDisposalProbe(
    databaseId: string
): Promise<NativeIndexedDbTimingDisposalProbe> {
    const database = await openProbeDatabase(`playwright-indexeddb-disposal-${databaseId}`);
    const recorder = new NativeIndexedDbTimingRecorder(20);
    try {
        recorder.start();
        const transaction = database.transaction('entries', 'readwrite');
        transaction.objectStore('entries').put({ value: 'completed-after-stop' }, 'pending');
        const completion = readTransaction(transaction);
        recorder.stop();
        const samplesAtStop = recorder.snapshot().samples.length;
        await completion;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const stopped = recorder.snapshot();
        return {
            samplesAtStop,
            samplesAfterCompletion: stopped.samples.length,
            uncapturedInFlightObservationCount: stopped.uncapturedInFlightObservationCount,
            durableValue: await readProbeValue(database, 'pending'),
            methodsRestored: recorder.methodsRestored
        };
    }
    finally {
        recorder.stop();
        database.close();
    }
}

export async function runNativeIndexedDbTimingPreCaptureTransactionProbe(
    databaseId: string
): Promise<NativeIndexedDbTimingPreCaptureTransactionProbe> {
    const database = await openProbeDatabase(`playwright-indexeddb-pre-capture-${databaseId}`);
    const recorder = new NativeIndexedDbTimingRecorder(20);
    try {
        const transaction = database.transaction('entries', 'readwrite');
        const completion = readTransaction(transaction);
        recorder.start();
        let operationResult: 'returned' | 'threw' = 'returned';
        let operationError: string | null = null;
        try {
            transaction.objectStore('entries').put({ value: 'persisted' }, 'pre-capture');
        }
        catch (error) {
            operationResult = 'threw';
            operationError = error instanceof Error ? error.message : String(error);
        }
        const transactionOutcome = await completion.then(() => 'complete' as const, () => 'abort' as const);
        recorder.stop();
        return {
            operationResult,
            operationError,
            transactionOutcome,
            durableValue: await readProbeValue(database, 'pre-capture'),
            uncapturedPreCaptureRequestCount: recorder.snapshot().uncapturedPreCaptureRequestCount,
            methodsRestored: recorder.methodsRestored
        };
    }
    finally {
        recorder.stop();
        database.close();
    }
}

export async function runNativeIndexedDbTimingDatabaseFilterProbe(
    databaseId: string
): Promise<NativeIndexedDbTimingDatabaseFilterProbe> {
    const includedDatabaseName = `playwright-indexeddb-filter-included-${databaseId}`;
    const excludedDatabaseName = `playwright-indexeddb-filter-excluded-${databaseId}`;
    const includedDatabase = await openProbeDatabase(includedDatabaseName);
    let excludedDatabase: IDBDatabase | undefined;
    let recorder: NativeIndexedDbTimingRecorder | undefined;
    try {
        excludedDatabase = await openProbeDatabase(excludedDatabaseName);
        recorder = new NativeIndexedDbTimingRecorder(20, includedDatabaseName);
        recorder.start();
        await writeProbeValue(includedDatabase, 'included', 'included');
        await writeProbeValue(excludedDatabase, 'excluded', 'excluded');
        recorder.stop();
        return {
            ...recorder.snapshot(),
            includedDatabaseName,
            excludedDatabaseName,
            methodsRestored: recorder.methodsRestored
        };
    }
    finally {
        recorder?.stop();
        includedDatabase.close();
        excludedDatabase?.close();
    }
}

export async function runNativeIndexedDbTimingFailureCleanupProbe(
    databaseId: string
): Promise<NativeIndexedDbTimingFailureCleanupProbe> {
    const databaseName = `playwright-indexeddb-timing-${databaseId}`;
    const originalOpenCursor = IDBObjectStore.prototype.openCursor;
    let probeRejected = false;
    IDBObjectStore.prototype.openCursor = function () {
        throw new Error('injected cursor failure');
    } as typeof IDBObjectStore.prototype.openCursor;
    try {
        await runNativeIndexedDbTimingSemanticsProbe(databaseId);
    }
    catch {
        probeRejected = true;
    }
    finally {
        IDBObjectStore.prototype.openCursor = originalOpenCursor;
    }
    return { probeRejected, databaseDeleted: await deleteProbeDatabase(databaseName) };
}

async function deleteProbeDatabase(databaseName: string): Promise<boolean> {
    return await new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        const timeout = setTimeout(() => resolve(false), 1_000);
        request.addEventListener('success', () => {
            clearTimeout(timeout);
            resolve(true);
        }, { once: true });
        request.addEventListener('error', () => {
            clearTimeout(timeout);
            reject(request.error);
        }, { once: true });
    });
}

async function openProbeDatabase(dbName: string): Promise<IDBDatabase> {
    const request = indexedDB.open(dbName, 1);
    request.addEventListener('upgradeneeded', () => {
        const store = request.result.createObjectStore('entries');
        store.createIndex('by-value', 'value');
    });
    return await readRequest(request);
}

async function writeProbeValue(database: IDBDatabase, key: string, value: string): Promise<void> {
    const transaction = database.transaction('entries', 'readwrite');
    await readRequest(transaction.objectStore('entries').put({ value }, key));
    await readTransaction(transaction);
}

async function writeStructuredCloneProbeValue(database: IDBDatabase): Promise<void> {
    const transaction = database.transaction('entries', 'readwrite');
    const values = new Uint8Array([3, 5, 8]);
    await readRequest(transaction.objectStore('entries').put({ label: 'opaque', values }, 'structured-clone'));
    values[0] = 99;
    await readTransaction(transaction);
}

async function observeInvalidPutError(database: IDBDatabase): Promise<string | null> {
    const transaction = database.transaction('entries', 'readwrite');
    const completion = readTransaction(transaction);
    let errorName: string | null = null;
    try {
        transaction.objectStore('entries').put({ value: () => 'not cloneable' }, 'invalid');
    }
    catch (error) {
        errorName = error instanceof DOMException ? error.name : error instanceof Error ? error.name : String(error);
    }
    await completion;
    return errorName;
}

async function writeThenAbortProbeValue(database: IDBDatabase, key: string, value: string): Promise<void> {
    const transaction = database.transaction('entries', 'readwrite');
    await readRequest(transaction.objectStore('entries').put({ value }, key));
    const aborted = readTransactionAbort(transaction);
    transaction.abort();
    await aborted;
}

async function readFirstProbeCursor(database: IDBDatabase): Promise<void> {
    const transaction = database.transaction('entries', 'readonly');
    const request = transaction.objectStore('entries').openCursor();
    await readFirstCursorResult(request);
    await readTransaction(transaction);
}

async function exerciseProbeRequestInventory(database: IDBDatabase): Promise<void> {
    const transaction = database.transaction('entries', 'readwrite');
    const store = transaction.objectStore('entries');
    await Promise.all([
        readRequest(store.get('committed')),
        readRequest(store.getAll()),
        readRequest(store.delete('absent')),
        readFirstCursorResult(store.index('by-value').openCursor())
    ]);
    await readTransaction(transaction);
}

async function readFirstCursorResult(request: IDBRequest<IDBCursorWithValue | null>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        request.addEventListener('success', () => resolve(), { once: true });
        request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB cursor failed')), {
            once: true
        });
    });
}

async function readProbeValue(database: IDBDatabase, key: string): Promise<string | undefined> {
    const transaction = database.transaction('entries', 'readonly');
    const row = await readRequest<{ readonly value: string; } | undefined>(transaction.objectStore('entries').get(key));
    await readTransaction(transaction);
    return row?.value;
}

async function readStructuredCloneProbeValue(
    database: IDBDatabase
): Promise<Pick<NativeIndexedDbTimingSemanticsProbe, 'structuredCloneLabel' | 'structuredCloneValues'>> {
    const transaction = database.transaction('entries', 'readonly');
    const row = await readRequest<
        {
            readonly label: string;
            readonly values: Uint8Array;
        } | undefined
    >(transaction.objectStore('entries').get('structured-clone'));
    await readTransaction(transaction);
    return {
        structuredCloneLabel: row?.label,
        structuredCloneValues: [...(row?.values ?? [])]
    };
}

async function readRequest<T>(request: IDBRequest<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')), {
            once: true
        });
    });
}

async function readTransaction(transaction: IDBTransaction): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        transaction.addEventListener('complete', () => resolve(), { once: true });
        transaction.addEventListener(
            'abort',
            () => reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
            { once: true }
        );
        transaction.addEventListener(
            'error',
            () => reject(transaction.error ?? new Error('IndexedDB transaction failed')),
            { once: true }
        );
    });
}

async function readTransactionAbort(transaction: IDBTransaction): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        transaction.addEventListener('abort', () => resolve(), { once: true });
        transaction.addEventListener(
            'complete',
            () => reject(new Error('IndexedDB transaction unexpectedly committed')),
            { once: true }
        );
    });
}
