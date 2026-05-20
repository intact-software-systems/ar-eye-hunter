import {
    ObservableLoanedValue,
    type ObservableLoanedValueOptions,
} from './ObservableLoanedValue.ts';
import type { ValueEqualityChecker } from './ObservableLatestValue.ts';
import type { LoanedValueValidityChecker } from './LoanedValue.ts';
import {
    type LoanedRepositoryRefresh,
    type ObservableKeyedValueErrorHandler,
    type ObservableKeyedValueEvent,
    type ObservableKeyedValueListener,
    type ObservableKeyedValues,
    ObservableValueEventType,
    type PullKeyedValues,
    type ReadableKeyedValues,
    type Unsubscribe,
} from './RepositoryInterfaces.ts';

export type ObservableLoanedRepositoryOptions<K, V> = Readonly<{
    ttlMs?: number;
    isValid?: LoanedValueValidityChecker<V>;
    equals?: ValueEqualityChecker<V>;
    onObserverError?: ObservableKeyedValueErrorHandler<K, V>;
}>;

export class ObservableLoanedRepository<K, V>
    implements PullKeyedValues<K, V>, ObservableKeyedValues<K, V> {
    private readonly entries = new Map<K, ObservableLoanedValue<V>>();
    private readonly defaultValueOptions: ObservableLoanedValueOptions<V>;
    private readonly onObserverError?: ObservableKeyedValueErrorHandler<K, V>;
    private readonly listenersByType = new Map<
        ObservableValueEventType,
        Set<ObservableKeyedValueListener<K, V>>
    >();
    private readonly changeListeners = new Set<ObservableKeyedValueListener<K, V>>();
    private observerQueue: Promise<void> = Promise.resolve();

    public constructor(
        private readonly refresher: LoanedRepositoryRefresh<K, V>,
        options: ObservableLoanedRepositoryOptions<K, V> = {},
    ) {
        if (!refresher) {
            throw new Error('refresher is required');
        }

        this.defaultValueOptions = {
            ttlMs: options.ttlMs,
            isValid: options.isValid,
            equals: options.equals,
        };
        this.onObserverError = options.onObserverError;
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
        refresher: LoanedRepositoryRefresh<K, V>,
    ): Promise<V> {
        return this.getOrCreate(key).getWith((current) => refresher(key, current));
    }

    public async refresh(key: K): Promise<V> {
        return this.getOrCreate(key).refresh();
    }

    public async refreshWith(
        key: K,
        refresher: LoanedRepositoryRefresh<K, V>,
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
        return this.onTypeDo(ObservableValueEventType.Created, listener);
    }

    public onUpdatedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe {
        return this.onTypeDo(ObservableValueEventType.Updated, listener);
    }

    public onRefreshedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe {
        return this.onTypeDo(ObservableValueEventType.Refreshed, listener);
    }

    public onDeletedDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe {
        return this.onTypeDo(ObservableValueEventType.Deleted, listener);
    }

    public onChangeDo(listener: ObservableKeyedValueListener<K, V>): Unsubscribe {
        this.changeListeners.add(listener);
        return toUnsubscribe(() => {
            this.changeListeners.delete(listener);
        });
    }

    public async whenIdle(): Promise<void> {
        while (true) {
            const valueQueues = [...this.entries.values()].map(
                async (entry) => await entry.whenIdle(),
            );
            await Promise.all(valueQueues);

            const pending = this.observerQueue;
            await pending;
            await Promise.resolve();

            if (pending === this.observerQueue) {
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
                this.defaultValueOptions,
            );
            entry.onChangeDo((event) => {
                if (this.entries.get(key) !== entry) {
                    return;
                }

                this.emit({
                    ...event,
                    key,
                });
            });
            this.entries.set(key, entry);
        }

        return entry;
    }

    private emitDeletedIfPresent(
        key: K,
        hadValue: boolean,
        previous: V | undefined,
    ): void {
        if (!hadValue) {
            return;
        }

        this.emit({
            key,
            type: ObservableValueEventType.Deleted,
            previous,
            atEpochMs: Date.now(),
        });
    }

    private onTypeDo(
        type: ObservableValueEventType,
        listener: ObservableKeyedValueListener<K, V>,
    ): Unsubscribe {
        let listeners = this.listenersByType.get(type);
        if (!listeners) {
            listeners = new Set<ObservableKeyedValueListener<K, V>>();
            this.listenersByType.set(type, listeners);
        }

        listeners.add(listener);
        return toUnsubscribe(() => {
            listeners?.delete(listener);
            if (listeners?.size === 0) {
                this.listenersByType.delete(type);
            }
        });
    }

    private emit(event: ObservableKeyedValueEvent<K, V>): void {
        const listeners = [
            ...(this.listenersByType.get(event.type) ?? []),
            ...this.changeListeners,
        ];

        if (listeners.length === 0) {
            return;
        }

        this.observerQueue = this.observerQueue.then(
            async () => {
                await Promise.all(
                    listeners.map(async (listener) => {
                        await this.notifyListener(listener, event);
                    }),
                );
            },
            async () => {
                await Promise.all(
                    listeners.map(async (listener) => {
                        await this.notifyListener(listener, event);
                    }),
                );
            },
        );
    }

    private async notifyListener(
        listener: ObservableKeyedValueListener<K, V>,
        event: ObservableKeyedValueEvent<K, V>,
    ): Promise<void> {
        try {
            await listener(event);
        } catch (error) {
            await this.handleObserverError(error, event);
        }
    }

    private async handleObserverError(
        error: unknown,
        event: ObservableKeyedValueEvent<K, V>,
    ): Promise<void> {
        if (this.onObserverError) {
            try {
                await this.onObserverError(error, event);
            } catch (handlerError) {
                console.error('Error handling observable loaned keyed value observer failure', handlerError);
            }
            return;
        }

        console.error('Error notifying observable loaned keyed value listener', error);
    }
}

function toUnsubscribe(unsubscribe: () => void): Unsubscribe {
    let active = true;
    return {
        unsubscribe: () => {
            if (!active) {
                return;
            }

            active = false;
            unsubscribe();
        },
    };
}
