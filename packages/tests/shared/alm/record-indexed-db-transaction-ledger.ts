import { vi } from 'vitest';

import type {
    IndexedDbOperation,
    IndexedDbOperationObserver,
    IndexedDbOperationOwner
} from '@shared/persistence/indexed-db-operation-observer.ts';

/**
 * `chain` runs from the call that admits the message to the carrier's send, `after-send` from that
 * send until the owner is idle again, and `before` is everything the test did first.
 */
export type IndexedDbLedgerPhase = 'before' | 'chain' | 'after-send';

export interface IndexedDbLedgerTransaction {
    /** 1-based, in the order the transactions were opened. */
    readonly order: number;
    readonly mode: IDBTransactionMode;
    readonly stores: readonly string[];
    /** `<store>.<method>(<key>)` or `<store>.<index>.<method>(<range>)`, in the order they were issued. */
    readonly requests: readonly string[];
    readonly phase: IndexedDbLedgerPhase;
    /** `<owner>/<kind>` of every logical operation that joined this transaction. */
    readonly operations: readonly string[];
}

export interface IndexedDbLedgerOperation extends IndexedDbOperation {
    readonly phase: IndexedDbLedgerPhase;
}

export interface IndexedDbTransactionLedger {
    readonly transactions: readonly IndexedDbLedgerTransaction[];
    readonly operations: readonly IndexedDbLedgerOperation[];
    /** The phase of every request issued on a transaction the ledger did not record. */
    readonly droppedRequestPhases: readonly IndexedDbLedgerPhase[];
}

export interface IndexedDbLedgerTotals {
    readonly transactions: number;
    readonly requests: number;
    /** Requests in these phases that no transaction row holds, so the request figure misses them. */
    readonly droppedRequests: number;
    readonly byOwner: Readonly<Record<IndexedDbOperationOwner, number>>;
}

export interface RecordedIndexedDbTransactionLedger {
    /** The observer the stores under test report their logical operations to. */
    readonly observer: IndexedDbOperationObserver;
    /** Every transaction opened and operation observed from now on belongs to this phase. */
    setPhase(phase: IndexedDbLedgerPhase): void;
    /** Transactions that have not completed, aborted or failed yet. */
    liveCount(): number;
    getLedger(): IndexedDbTransactionLedger;
}

interface LedgerTransactionState {
    readonly entry: IndexedDbLedgerTransaction & { requests: string[]; operations: string[]; };
    live: boolean;
}

interface LedgerState {
    phase: IndexedDbLedgerPhase;
    readonly transactions: LedgerTransactionState[];
    readonly byTransaction: Map<IDBTransaction, LedgerTransactionState>;
    readonly operations: IndexedDbLedgerOperation[];
    readonly droppedRequestPhases: IndexedDbLedgerPhase[];
    /** Operations observed before any request of theirs: the next request's transaction takes them. */
    pendingOperations: string[];
}

type RequestSource = 'store' | 'index';

/** A key, a key range, or the value a put or add stores. */
type RequestKey = IDBValidKey | IDBKeyRange | object | null | undefined;

/** The first argument is a key, a key range or a stored value; the second is a count or an out-of-line key. */
type RequestArguments = [first?: RequestKey, second?: IDBValidKey];

const STORE_REQUEST_METHODS = [
    'get',
    'getAll',
    'getAllKeys',
    'getKey',
    'count',
    'openCursor',
    'openKeyCursor',
    'put',
    'add',
    'delete'
] as const;
const INDEX_REQUEST_METHODS = [
    'get',
    'getAll',
    'getAllKeys',
    'getKey',
    'count',
    'openCursor',
    'openKeyCursor'
] as const;

/**
 * Patches `IDBDatabase.prototype.transaction` and the object-store and index request methods for the
 * rest of the test: every suite using this needs `vi.restoreAllMocks()` in an `afterEach`.
 *
 * An operation reports itself either before its first request (a read, a write, a page read) or
 * after the read that decided it (a reservation, or a probe that computed no write). So an operation
 * joins the newest transaction when that one is a readonly read no operation has joined yet, and
 * otherwise the transaction its next request is issued on. The join holds for a run with one chain of
 * work in flight; it only labels the table, and no count depends on it.
 *
 * Two kinds of request are not in a transaction's row. A request on a transaction the ledger never
 * saw opened, such as the `versionchange` transaction of a database upgrade, is counted in
 * `droppedRequests` so it cannot hide. A cursor's `continue` and `advance` steps are not patched and
 * are not counted: only the store and index calls that start a read or a write are requests here.
 */
export function recordIndexedDbTransactionLedger(): RecordedIndexedDbTransactionLedger {
    const state: LedgerState = {
        phase: 'before',
        transactions: [],
        byTransaction: new Map(),
        operations: [],
        droppedRequestPhases: [],
        pendingOperations: []
    };
    recordOpenedTransactions(state);
    recordIssuedRequests(state, IDBObjectStore.prototype, 'store');
    recordIssuedRequests(state, IDBIndex.prototype, 'index');
    return {
        observer: { observe: (operation) => recordOperation(state, operation) },
        setPhase: (phase) => {
            state.phase = phase;
        },
        liveCount: () => state.transactions.filter((recorded) => recorded.live).length,
        getLedger: () => ({
            transactions: state.transactions.map(({ entry }) => ({
                ...entry,
                requests: [...entry.requests],
                operations: [...entry.operations]
            })),
            operations: [...state.operations],
            droppedRequestPhases: [...state.droppedRequestPhases]
        })
    };
}

export function computeIndexedDbLedgerTotals(
    ledger: IndexedDbTransactionLedger,
    phases: readonly IndexedDbLedgerPhase[]
): IndexedDbLedgerTotals {
    const transactions = ledger.transactions.filter((transaction) => phases.includes(transaction.phase));
    const operations = ledger.operations.filter((operation) => phases.includes(operation.phase));
    return {
        transactions: transactions.length,
        requests: transactions.reduce(
            (count, transaction) => count + transaction.requests.length,
            0
        ),
        droppedRequests: ledger.droppedRequestPhases.filter((phase) => phases.includes(phase)).length,
        byOwner: {
            'al-admission': operations.filter((operation) => operation.owner === 'al-admission').length,
            'al-work': operations.filter((operation) => operation.owner === 'al-work').length
        }
    };
}

/** One line per transaction, so a failed pin shows which transaction appeared or went away. */
export function toIndexedDbLedgerTable(ledger: IndexedDbTransactionLedger): string {
    return ledger.transactions.map((transaction) =>
        [
            `#${transaction.order}`,
            transaction.phase,
            transaction.mode,
            `[${transaction.stores.join(',')}]`,
            `ops=${transaction.operations.join(',') || '-'}`,
            `requests=${transaction.requests.length}: ${transaction.requests.join(' ')}`
        ].join(' ')
    ).join('\n');
}

function recordOpenedTransactions(state: LedgerState): void {
    const openTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
    ) {
        const transaction = openTransaction.call(this, storeNames, mode, options);
        const recorded: LedgerTransactionState = {
            live: true,
            entry: {
                order: state.transactions.length + 1,
                mode: mode ?? 'readonly',
                stores: typeof storeNames === 'string' ? [storeNames] : [...storeNames],
                requests: [],
                phase: state.phase,
                operations: []
            }
        };
        state.transactions.push(recorded);
        state.byTransaction.set(transaction, recorded);
        for (const ended of ['complete', 'abort', 'error']) {
            transaction.addEventListener(ended, () => {
                recorded.live = false;
            });
        }
        return transaction;
    });
}

function recordIssuedRequests(
    state: LedgerState,
    prototype: IDBObjectStore | IDBIndex,
    source: RequestSource
): void {
    const methods = source === 'store' ? STORE_REQUEST_METHODS : INDEX_REQUEST_METHODS;
    for (const method of methods) {
        const issue = Reflect.get(prototype, method) as (...args: RequestArguments) => IDBRequest;
        vi.spyOn(prototype as IDBObjectStore, method).mockImplementation(function (
            this: IDBObjectStore | IDBIndex,
            ...args: RequestArguments
        ) {
            recordRequest(state, this, `${method}(${toRequestKeyText(this, method, args)})`);
            return issue.apply(this, args);
        } as never);
    }
}

function recordRequest(state: LedgerState, source: IDBObjectStore | IDBIndex, call: string): void {
    const store = source instanceof IDBIndex ? source.objectStore : source;
    const recorded = state.byTransaction.get(store.transaction);
    if (recorded === undefined) {
        state.droppedRequestPhases.push(state.phase);
        return;
    }
    const name = source instanceof IDBIndex ? `${store.name}.${source.name}` : store.name;
    recorded.entry.requests.push(`${name}.${call}`);
    recorded.entry.operations.push(...state.pendingOperations);
    state.pendingOperations = [];
}

function recordOperation(state: LedgerState, operation: IndexedDbOperation): void {
    state.operations.push({ ...operation, phase: state.phase });
    const name = `${operation.owner}/${operation.kind}`;
    const newest = state.transactions.at(-1)?.entry;
    const decidedByItsRead = newest !== undefined && newest.mode === 'readonly' &&
        newest.requests.length > 0 &&
        newest.operations.length === 0;
    if (decidedByItsRead) {
        newest.operations.push(name);
        return;
    }
    state.pendingOperations.push(name);
}

function toRequestKeyText(
    source: IDBObjectStore | IDBIndex,
    method: string,
    args: RequestArguments
): string {
    const [first, second] = args;
    if (method !== 'put' && method !== 'add') {
        return toKeyText(first);
    }
    if (second !== undefined) {
        return toKeyText(second);
    }
    const keyPath = source.keyPath;
    return typeof keyPath === 'string' && typeof first === 'object' && first !== null
        ? toKeyText(Reflect.get(first, keyPath))
        : '';
}

function toKeyText(key: RequestKey): string {
    if (key === undefined) {
        return '';
    }
    if (typeof key === 'string') {
        return key;
    }
    if (key instanceof IDBKeyRange) {
        return `${toKeyText(key.lower)}..${toKeyText(key.upper)}`;
    }
    return JSON.stringify(key);
}
