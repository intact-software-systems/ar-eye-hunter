import type { LoanedValue, LoanedValueOptions, LoanedValueRefresh } from './LoanedValue.ts';
import type { LatestValue, LatestValueOptions } from './LatestValue.ts';

export const ObservableValueEventType = {
    Created: 'created',
    Updated: 'updated',
    Refreshed: 'refreshed',
    Deleted: 'deleted',
} as const;

export type ObservableValueEventType =
    (typeof ObservableValueEventType)[keyof typeof ObservableValueEventType];

export type ObservableValueEvent<T> = Readonly<{
    type: ObservableValueEventType;
    value?: T;
    previous?: T;
    atEpochMs: number;
}>;

export type ObservableValueListener<T> = (
    event: ObservableValueEvent<T>,
) => void | Promise<void>;

export type ObservableValueErrorHandler<T> = (
    error: unknown,
    event: ObservableValueEvent<T>,
) => void | Promise<void>;

export interface Unsubscribe {
    unsubscribe(): void;
}

export interface ObservableValue<T> {
    onCreatedDo(listener: ObservableValueListener<T>): Unsubscribe;

    onUpdatedDo(listener: ObservableValueListener<T>): Unsubscribe;

    onRefreshedDo(listener: ObservableValueListener<T>): Unsubscribe;

    onDeletedDo(listener: ObservableValueListener<T>): Unsubscribe;

    /**
     * Receives every observable value event, including refreshed events.
     */
    onChangeDo(listener: ObservableValueListener<T>): Unsubscribe;
}

export type ObservableKeyedValueEvent<K, V> =
    & ObservableValueEvent<V>
    & Readonly<{
    key: K;
}>;

export type ObservableKeyedValueListener<K, V> = (
    event: ObservableKeyedValueEvent<K, V>,
) => void | Promise<void>;

export type ObservableKeyedValueErrorHandler<K, V> = (
    error: unknown,
    event: ObservableKeyedValueEvent<K, V>,
) => void | Promise<void>;

export interface ObservableKeyedValues<K, V> {
    onCreatedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe;

    onUpdatedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe;

    onRefreshedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe;

    onDeletedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe;

    /**
     * Receives every observable keyed value event, including refreshed events.
     */
    onChangeDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe;
}

export interface ReadableKeyedValues<K, V> {
    read(key: K): V | undefined;

    peek(key: K): V | undefined;

    hasValue(key: K): boolean;

    expired(key: K): boolean;

    refreshing(key: K): boolean;

    has(key: K): boolean;

    delete(key: K): boolean;

    clear(key: K): void;

    clearAll(): void;

    deleteExpired(): number;

    size(): number;

    keys(): IterableIterator<K>;

    readAllValues(): V[];
}

export type UpdateIfNewerOptions<V> = Readonly<{
    versionOf: (value: V) => number;
    onNewer?: (next: V, current: V) => void;
    onStale?: (next: V, current: V) => void;
}>;

export type LoanedRepositoryRefresh<K, V> = (
    key: K,
    current: V | undefined,
) => V | Promise<V>;

export interface PullKeyedValues<K, V> extends ReadableKeyedValues<K, V> {
    get(key: K): Promise<V>;

    getWith(key: K, refresher: LoanedRepositoryRefresh<K, V>): Promise<V>;

    refresh(key: K): Promise<V>;

    refreshWith(key: K, refresher: LoanedRepositoryRefresh<K, V>): Promise<V>;

    take(key: K): V | undefined;

    takeIfExpired(key: K): V | undefined;
}

export interface PushKeyedValues<K, V> extends ReadableKeyedValues<K, V> {
    get(key: K): V;

    getOrElse(key: K, fallback: V): V;

    getOrElseGet(key: K, factory: () => V): V;

    accept(key: K, value: V): void;

    next(key: K, value: V): void;

    set(key: K, value: V): this;

    asCallback(key: K): (value: V) => void;

    compareAndSet(key: K, expect: V | undefined, update: V): boolean;

    getAndSet(key: K, update: V): V | undefined;

    touch(key: K): boolean;

    updateIfPresent(key: K, updater: (current: V) => V): boolean;

    updateOrCreate(key: K, updater: (current: V | undefined) => V): boolean;

    setIfAbsent(key: K, creator: () => V): V;

    take(key: K): V | undefined;

    takeIfExpired(key: K): V | undefined;
}

export interface KeyedValueHistory<K, V> {
    undo(key: K): V | undefined;

    redo(key: K): V | undefined;

    canUndo(key: K): boolean;

    canRedo(key: K): boolean;

    undoStack(key: K): readonly V[];

    redoStack(key: K): readonly V[];

    peekUndoValue(key: K): V | undefined;

    peekRedoValue(key: K): V | undefined;

    peekUndoValueAt(key: K, index: number): V | undefined;

    peekRedoValueAt(key: K, index: number): V | undefined;

    clearUndo(key: K): this;

    clearRedo(key: K): this;

    clearHistory(key: K): this;
}

export interface PullMementoKeyedValues<K, V>
    extends PullKeyedValues<K, V>, KeyedValueHistory<K, V> {
    setLoan(key: K, loan: LoanedValue<V> | undefined): this;

    commitLoan(key: K, loan: LoanedValue<V> | undefined): this;

    setRefresher(
        key: K,
        refresher: LoanedValueRefresh<V>,
        options?: LoanedValueOptions<V>,
    ): this;

    commitRefresher(
        key: K,
        refresher: LoanedValueRefresh<V>,
        options?: LoanedValueOptions<V>,
    ): this;

    setValue(key: K, value: V, options?: LoanedValueOptions<V>): this;

    commitValue(key: K, value: V, options?: LoanedValueOptions<V>): this;
}

export interface PushMementoKeyedValues<K, V>
    extends PushKeyedValues<K, V>, KeyedValueHistory<K, V> {
    commitLatest(key: K, latest: LatestValue<V> | undefined): this;

    commitValue(key: K, value: V, options?: LatestValueOptions<V>): this;
}
