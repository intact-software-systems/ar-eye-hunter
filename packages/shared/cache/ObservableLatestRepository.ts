import {
    ObservableLatestValue,
    type ObservableLatestValueOptions,
    type ValueEqualityChecker,
} from './ObservableLatestValue.ts';
import {
    ObservableValueEventType,
    type ObservableKeyedValueErrorHandler,
    type ObservableKeyedValueEvent,
    type ObservableKeyedValueListener,
    type ObservableKeyedValues,
    type PushKeyedValues,
    type ReadableKeyedValues,
    type Unsubscribe,
    type UpdateIfNewerOptions,
} from './RepositoryInterfaces.ts';

export type ObservableLatestRepositoryOptions<K, V> = Readonly<{
    ttlMs?: number;
    isValid?: (value: V) => boolean;
    equals?: ValueEqualityChecker<V>;
    onObserverError?: ObservableKeyedValueErrorHandler<K, V>;
}>;

export class ObservableLatestRepository<K, V>
    implements PushKeyedValues<K, V>, ObservableKeyedValues<K, V> {
    private readonly entries = new Map<K, ObservableLatestValue<V>>();
    private readonly defaultValueOptions: ObservableLatestValueOptions<V>;
    private readonly onObserverError?: ObservableKeyedValueErrorHandler<K, V>;
    private readonly listenersByType = new Map<
        ObservableValueEventType,
        Set<ObservableKeyedValueListener<K, V>>
    >();
    private readonly changeListeners = new Set<ObservableKeyedValueListener<K, V>>();
    private observerQueue: Promise<void> = Promise.resolve();

    public constructor(options: ObservableLatestRepositoryOptions<K, V> = {}) {
        this.defaultValueOptions = {
            ttlMs: options.ttlMs,
            isValid: options.isValid,
            equals: options.equals,
        };
        this.onObserverError = options.onObserverError;
    }

    public accept(key: K, value: V): void {
        this.getOrCreate(key).accept(value);
    }

    public async acceptAndNotify(key: K, value: V): Promise<void> {
        this.accept(key, value);
        await this.whenIdle();
    }

    public next(key: K, value: V): void {
        this.accept(key, value);
    }

    public set(key: K, value: V): this {
        this.accept(key, value);
        return this;
    }

    public asCallback(key: K): (value: V) => void {
        return (value: V) => {
            this.accept(key, value);
        };
    }

    public latest(key: K): ObservableLatestValue<V> {
        return this.getOrCreate(key);
    }

    public read(key: K): V | undefined {
        return this.entries.get(key)?.read();
    }

    public peek(key: K): V | undefined {
        return this.entries.get(key)?.peek();
    }

    public get(key: K): V {
        const entry = this.entries.get(key);
        if (!entry) {
            throw new Error(`No latest value available for key: ${String(key)}`);
        }
        return entry.get();
    }

    public getOrElse(key: K, fallback: V): V {
        return this.entries.get(key)?.getOrElse(fallback) ?? fallback;
    }

    public getOrElseGet(key: K, factory: () => V): V {
        return this.entries.get(key)?.getOrElseGet(factory) ?? factory();
    }

    public hasValue(key: K): boolean {
        return this.entries.get(key)?.hasValue() ?? false;
    }

    public expired(key: K): boolean {
        const entry = this.entries.get(key);
        return entry ? entry.expired() : true;
    }

    public refreshing(key: K): boolean {
        return this.entries.get(key)?.refreshing() ?? false;
    }

    public take(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }

        const value = entry.take();
        this.entries.delete(key);
        return value;
    }

    public takeIfExpired(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }

        const wasExpired = entry.expired();
        const value = entry.takeIfExpired();
        if (wasExpired) {
            this.entries.delete(key);
        }
        return value;
    }

    public compareAndSet(key: K, expect: V | undefined, update: V): boolean {
        return this.getOrCreate(key).compareAndSet(expect, update);
    }

    public getAndSet(key: K, update: V): V | undefined {
        return this.getOrCreate(key).getAndSet(update);
    }

    public touch(key: K): boolean {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }

        return entry.touch();
    }

    public updateIfPresent(key: K, updater: (current: V) => V): boolean {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }

        const current = entry.peek();
        if (current === undefined) {
            return false;
        }

        entry.set(updater(current));
        return true;
    }

    public updateOrCreate(
        key: K,
        updater: (current: V | undefined) => V,
    ): boolean {
        const entry = this.getOrCreate(key);
        entry.set(updater(entry.peek() ?? undefined));
        return true;
    }

    public updateIfNewer(
        key: K,
        next: V,
        options: UpdateIfNewerOptions<V>,
    ): boolean {
        let isUpdated = false;

        this.updateOrCreate(key, (current) => {
            if (current === undefined) {
                isUpdated = true;
                return next;
            }

            if (options.versionOf(next) > options.versionOf(current)) {
                options.onNewer?.(next, current);
                isUpdated = true;
                return next;
            }

            options.onStale?.(next, current);
            return current;
        });

        return isUpdated;
    }

    public setIfAbsent(key: K, creator: () => V): V {
        const latestValue = this.getOrCreate(key);
        const existingValue = latestValue.read();

        if (existingValue === undefined) {
            const value = creator();
            latestValue.set(value);
            return value;
        }

        return existingValue;
    }

    public has(key: K): boolean {
        return this.entries.has(key);
    }

    public delete(key: K): boolean {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }

        entry.clear();
        this.entries.delete(key);
        return true;
    }

    public clear(key: K): void {
        const entry = this.entries.get(key);
        if (!entry) {
            return;
        }

        entry.clear();
        this.entries.delete(key);
    }

    public clearAll(): void {
        for (const entry of this.entries.values()) {
            entry.clear();
        }
        this.entries.clear();
    }

    public deleteExpired(): number {
        let removed = 0;

        for (const [key, entry] of this.entries) {
            if (entry.expired()) {
                entry.takeIfExpired();
                this.entries.delete(key);
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

    public values(): IterableIterator<ObservableLatestValue<V>> {
        return this.entries.values();
    }

    public entriesView(): IterableIterator<[K, ObservableLatestValue<V>]> {
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

    private getOrCreate(key: K): ObservableLatestValue<V> {
        let entry = this.entries.get(key);

        if (!entry) {
            entry = new ObservableLatestValue<V>(this.defaultValueOptions);
            entry.onChangeDo((event) => {
                this.emit({
                    ...event,
                    key,
                });
            });
            this.entries.set(key, entry);
        }

        return entry;
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
                console.error('Error handling observable keyed value observer failure', handlerError);
            }
            return;
        }

        console.error('Error notifying observable keyed value listener', error);
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
