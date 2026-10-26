import type { LoanedValueValidityChecker } from '../LoanedValue.ts';
import {
    ObservableValueEventType,
    type LoanedRepositoryRefresh,
    type ObservableKeyedValueErrorHandler,
    type ObservableKeyedValueEvent,
    type ObservableKeyedValueListener,
    type ObservableKeyedValues,
    type PullKeyedValues,
    type ReadableKeyedValues,
    type Unsubscribe
} from '../RepositoryInterfaces.ts';
import type { ValueEqualityChecker } from './observable-latest-value.ts';
import { ObservableLoanedValue, type ObservableLoanedValueOptions } from './observable-loaned-value.ts';
import { QueuedNotifications } from './queued-notifications.ts';

export interface ObservableLoanedRepositoryOptions<K, V> {
    readonly ttlMs?: number;
    readonly isValid?: LoanedValueValidityChecker<V>;
    readonly equals?: ValueEqualityChecker<V>;
    readonly onObserverError?: ObservableKeyedValueErrorHandler<K, V>;
}

export class ObservableLoanedRepository<K, V> implements PullKeyedValues<K, V>, ObservableKeyedValues<K, V> {
    private readonly entries = new Map<K, ObservableLoanedValue<V>>();
    private readonly defaultValueOptions: ObservableLoanedValueOptions<V>;
    private readonly notifications: QueuedNotifications<ObservableKeyedValueEvent<K, V>>;

    private readonly refresher: LoanedRepositoryRefresh<K, V>;

    public constructor(
        refresher: LoanedRepositoryRefresh<K, V>,
        options: ObservableLoanedRepositoryOptions<K, V> = {}
    ) {
        this.refresher = refresher;
        if (!refresher) {
            throw new Error('refresher is required');
        }

        this.defaultValueOptions = {
            ttlMs: options.ttlMs,
            isValid: options.isValid,
            equals: options.equals
        };
        this.notifications = new QueuedNotifications(options.onObserverError);
    }

    public loaned(key: K): ObservableLoanedValue<V> {
        return this.getOrCreate(key);
    }

    public read(key: K): V | undefined {
        return this.entries.get(key)?.read();
    }

    public peek(key: K): V | undefined {
        return this.entries.get(key)?.peek();
    }

    public async get(key: K): Promise<V> {
        return this.getOrCreate(key).get();
    }

    public async getWith(
        key: K,
        refresher: LoanedRepositoryRefresh<K, V>
    ): Promise<V> {
        return this.getOrCreate(key).getWith((current) => refresher(key, current));
    }

    public async refresh(key: K): Promise<V> {
        return this.getOrCreate(key).refresh();
    }

    public async refreshWith(
        key: K,
        refresher: LoanedRepositoryRefresh<K, V>
    ): Promise<V> {
        return this.getOrCreate(key).refreshWith((current) => refresher(key, current));
    }

    public take(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }

        const previous = entry.peek();
        const hadValue = entry.hasValue();
        const value = entry.take();
        this.entries.delete(key);
        this.emitDeletedIfPresent(key, hadValue, previous);
        return value;
    }

    public takeIfExpired(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }

        const wasExpired = entry.expired();
        const previous = entry.peek();
        const hadValue = entry.hasValue();
        const value = entry.takeIfExpired();
        if (wasExpired) {
            this.entries.delete(key);
            this.emitDeletedIfPresent(key, hadValue, previous);
        }
        return value;
    }

    public hasValue(key: K): boolean {
        return this.entries.get(key)?.hasValue() ?? false;
    }

    public refreshing(key: K): boolean {
        return this.entries.get(key)?.refreshing() ?? false;
    }

    public expired(key: K): boolean {
        const entry = this.entries.get(key);
        return entry ? entry.expired() : true;
    }

    public has(key: K): boolean {
        return this.entries.has(key);
    }

    public delete(key: K): boolean {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }

        const previous = entry.peek();
        const hadValue = entry.hasValue();
        entry.clear();
        this.entries.delete(key);
        this.emitDeletedIfPresent(key, hadValue, previous);
        return true;
    }

    public compareAndDelete(key: K, expected: V): boolean {
        const entry = this.entries.get(key);
        return entry !== undefined && entry.peek() === expected && this.delete(key);
    }

    public clear(key: K): void {
        const entry = this.entries.get(key);
        if (!entry) {
            return;
        }

        const previous = entry.peek();
        const hadValue = entry.hasValue();
        entry.clear();
        this.entries.delete(key);
        this.emitDeletedIfPresent(key, hadValue, previous);
    }

    public clearAll(): void {
        for (const [key, entry] of this.entries) {
            const previous = entry.peek();
            const hadValue = entry.hasValue();
            entry.clear();
            this.emitDeletedIfPresent(key, hadValue, previous);
        }
        this.entries.clear();
    }

    public deleteExpired(): number {
        let removed = 0;

        for (const [key, entry] of this.entries) {
            if (!entry.refreshing() && entry.expired()) {
                const previous = entry.peek();
                const hadValue = entry.hasValue();
                entry.takeIfExpired();
                this.entries.delete(key);
                this.emitDeletedIfPresent(key, hadValue, previous);
                removed += 1;
            }
        }

        return removed;
    }

    public size(): number {
        return this.entries.size;
    }

    public keys(): IterableIterator<K> {
        return this.entries.keys();
    }

    public values(): IterableIterator<ObservableLoanedValue<V>> {
        return this.entries.values();
    }

    public entriesView(): IterableIterator<[K, ObservableLoanedValue<V>]> {
        return this.entries.entries();
    }

    public readAllValues(): V[] {
        const values: V[] = [];

        for (const entry of this.entries.values()) {
            const value = entry.read();
            if (value !== undefined) {
                values.push(value);
            }
        }

        return values;
    }

    public onCreatedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe {
        return this.notifications.subscribeType(ObservableValueEventType.Created, listener);
    }

    public onUpdatedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe {
        return this.notifications.subscribeType(ObservableValueEventType.Updated, listener);
    }

    public onRefreshedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe {
        return this.notifications.subscribeType(ObservableValueEventType.Refreshed, listener);
    }

    public onDeletedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe {
        return this.notifications.subscribeType(ObservableValueEventType.Deleted, listener);
    }

    public onChangeDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe {
        return this.notifications.subscribe(listener);
    }

    public async whenIdle(): Promise<void> {
        while (true) {
            const pending = this.notifications.completion;
            await pending;
            // Repository observers may start entry work without publishing its result yet.
            await Promise.all([...this.entries.values()].map((entry) => entry.whenIdle()));
            if (pending === this.notifications.completion) {
                return;
            }
        }
    }

    public readable(): ReadableKeyedValues<K, V> {
        return this;
    }

    private getOrCreate(key: K): ObservableLoanedValue<V> {
        let entry = this.entries.get(key);

        if (!entry) {
            entry = new ObservableLoanedValue<V>(
                (current) => this.refresher(key, current),
                this.defaultValueOptions
            );
            entry.onChangeDo((event) => {
                if (this.entries.get(key) !== entry) {
                    return;
                }

                this.notifications.publish({
                    ...event,
                    key
                });
            });
            this.entries.set(key, entry);
        }

        return entry;
    }

    private emitDeletedIfPresent(
        key: K,
        hadValue: boolean,
        previous: V | undefined
    ): void {
        if (!hadValue) {
            return;
        }

        this.notifications.publish({
            key,
            type: ObservableValueEventType.Deleted,
            previous,
            atEpochMs: Date.now()
        });
    }
}
