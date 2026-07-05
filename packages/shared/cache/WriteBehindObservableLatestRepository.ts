import { NEVER_EXPIRE_AT_TIMESTAMP, type PersistenceProvider, } from '../persistence/PersistenceProvider.ts';
import { ObservableLatestRepository, type ObservableLatestRepositoryOptions, } from './ObservableLatestRepository.ts';
import type { ObservableLatestValue } from './ObservableLatestValue.ts';
import {
    type ObservableKeyedValueEvent,
    type ObservableKeyedValueListener,
    type ObservableKeyedValues,
    ObservableValueEventType,
    type PushKeyedValues,
    type ReadableKeyedValues,
    type Unsubscribe,
    type UpdateIfNewerOptions,
} from './RepositoryInterfaces.ts';

export type PersistenceErrorHandler<K, V> = (
    error: unknown,
    event: ObservableKeyedValueEvent<K, V>,
) => void | Promise<void>;

export type WriteBehindObservableLatestRepositoryOptions<K, V> =
    & ObservableLatestRepositoryOptions<K, V>
    & Readonly<{
    persistence: PersistenceProvider<K, V>;
    onPersistenceError?: PersistenceErrorHandler<K, V>;
    /**
     * Maps a written value to its absolute on-disk expiry timestamp.
     * Default: now + ttlMs when ttlMs is set, otherwise NEVER_EXPIRE_AT_TIMESTAMP.
     */
    expireAtFor?: (value: V) => number;
}>;

/**
 * Write-behind cache: writes update RAM synchronously and the persistence layer
 * is updated in the background via the observable event surface.
 *
 * - Reads are served from RAM; the persistence layer never participates in the read path.
 * - Created/Updated events propagate to setItem; Deleted events propagate to removeItem.
 * - Refreshed events are ignored: the equality predicate already determined no real change.
 * - Hydrate before use. The persistence-mirror listener is installed only after the initial
 *   load completes, so disk -> RAM events do not loop back through the writer.
 *
 * Strong points: low write latency, observers fire immediately, simple API
 * (still implements PushKeyedValues<K, V>). Weak point: a tab-close mid-flush
 * can lose the most-recent in-flight writes. Use WriteThroughObservableLatestRepository
 * when durability matters more than write latency.
 */
export class WriteBehindObservableLatestRepository<K, V>
    implements PushKeyedValues<K, V>, ObservableKeyedValues<K, V> {
    private readonly memory: ObservableLatestRepository<K, V>;
    private readonly persistence: PersistenceProvider<K, V>;
    private readonly onPersistenceError?: PersistenceErrorHandler<K, V>;
    private readonly expireAtFor: (value: V) => number;

    private hydrationPromise: Promise<void> | undefined;
    private mirrorSubscription: Unsubscribe | undefined;
    private writeChain: Promise<void> = Promise.resolve();

    public constructor(
        options: WriteBehindObservableLatestRepositoryOptions<K, V>,
    ) {
        this.memory = new ObservableLatestRepository<K, V>(options);
        this.persistence = options.persistence;
        this.onPersistenceError = options.onPersistenceError;

        const ttlMs = options.ttlMs;
        this.expireAtFor = options.expireAtFor ?? ((_value) =>
            ttlMs !== undefined && Number.isFinite(ttlMs)
                ? Date.now() + ttlMs
                : NEVER_EXPIRE_AT_TIMESTAMP);
    }

    public hydrate(): Promise<void> {
        if (!this.hydrationPromise) {
            this.hydrationPromise = this.runHydrate();
        }
        return this.hydrationPromise;
    }

    public whenHydrated(): Promise<void> {
        return this.hydrationPromise ?? Promise.resolve();
    }

    public isHydrated(): boolean {
        return this.mirrorSubscription !== undefined;
    }

    private async runHydrate(): Promise<void> {
        const keys = await this.persistence.getAllKeys();
        for (const key of keys) {
            const value = await this.persistence.getItem(key);
            if (value !== undefined) {
                this.memory.accept(key, value);
            }
        }

        // Drain any observer tasks queued by the hydration writes before we
        // attach the persistence mirror, so that re-loaded values do not loop
        // back to disk.
        await this.memory.whenIdle();

        this.mirrorSubscription = this.memory.onChangeDo((event) => {
            this.mirror(event);
        });
    }

    private mirror(event: ObservableKeyedValueEvent<K, V>): void {
        if (event.type === ObservableValueEventType.Refreshed) {
            return;
        }

        const apply = () =>
            this.applyMirror(event).catch((error) =>
                this.handlePersistenceError(error, event)
            );
        this.writeChain = this.writeChain.then(apply, apply);
    }

    private async applyMirror(
        event: ObservableKeyedValueEvent<K, V>,
    ): Promise<void> {
        if (event.type === ObservableValueEventType.Deleted) {
            await this.persistence.removeItem(event.key);
            return;
        }

        const value = event.value;
        if (value === undefined) {
            return;
        }

        await this.persistence.setItem(event.key, value, {
            expireAtTimestamp: this.expireAtFor(value),
        });
    }

    private async handlePersistenceError(
        error: unknown,
        event: ObservableKeyedValueEvent<K, V>,
    ): Promise<void> {
        if (this.onPersistenceError) {
            try {
                await this.onPersistenceError(error, event);
            } catch (handlerError) {
                console.error(
                    'Error handling persistent repository failure',
                    handlerError,
                );
            }
            return;
        }

        console.error('Error persisting observable repository write', error);
    }

    // ── PushKeyedValues delegation ───────────────────────────────────────────

    public accept(key: K, value: V): void {
        this.memory.accept(key, value);
    }

    public async acceptAndNotify(key: K, value: V): Promise<void> {
        this.accept(key, value);
        await this.whenIdle();
    }

    public next(key: K, value: V): void {
        this.memory.next(key, value);
    }

    public set(key: K, value: V): this {
        this.memory.set(key, value);
        return this;
    }

    public asCallback(key: K): (value: V) => void {
        return this.memory.asCallback(key);
    }

    public latest(key: K): ObservableLatestValue<V> {
        return this.memory.latest(key);
    }

    public read(key: K): V | undefined {
        return this.memory.read(key);
    }

    public peek(key: K): V | undefined {
        return this.memory.peek(key);
    }

    public get(key: K): V {
        return this.memory.get(key);
    }

    public getOrElse(key: K, fallback: V): V {
        return this.memory.getOrElse(key, fallback);
    }

    public getOrElseGet(key: K, factory: () => V): V {
        return this.memory.getOrElseGet(key, factory);
    }

    public hasValue(key: K): boolean {
        return this.memory.hasValue(key);
    }

    public expired(key: K): boolean {
        return this.memory.expired(key);
    }

    public refreshing(key: K): boolean {
        return this.memory.refreshing(key);
    }

    public take(key: K): V | undefined {
        return this.memory.take(key);
    }

    public takeIfExpired(key: K): V | undefined {
        return this.memory.takeIfExpired(key);
    }

    public compareAndSet(key: K, expect: V | undefined, update: V): boolean {
        return this.memory.compareAndSet(key, expect, update);
    }

    public getAndSet(key: K, update: V): V | undefined {
        return this.memory.getAndSet(key, update);
    }

    public touch(key: K): boolean {
        return this.memory.touch(key);
    }

    public updateIfPresent(key: K, updater: (current: V) => V): boolean {
        return this.memory.updateIfPresent(key, updater);
    }

    public updateOrCreate(
        key: K,
        updater: (current: V | undefined) => V,
    ): boolean {
        return this.memory.updateOrCreate(key, updater);
    }

    public setIfAbsent(key: K, creator: () => V): V {
        return this.memory.setIfAbsent(key, creator);
    }

    public updateIfNewer(
        key: K,
        next: V,
        options: UpdateIfNewerOptions<V>,
    ): boolean {
        return this.memory.updateIfNewer(key, next, options);
    }

    // ── ReadableKeyedValues delegation ───────────────────────────────────────

    public has(key: K): boolean {
        return this.memory.has(key);
    }

    public delete(key: K): boolean {
        return this.memory.delete(key);
    }

    public clear(key: K): void {
        this.memory.clear(key);
    }

    public clearAll(): void {
        this.memory.clearAll();
    }

    public deleteExpired(): number {
        return this.memory.deleteExpired();
    }

    public size(): number {
        return this.memory.size();
    }

    public keys(): IterableIterator<K> {
        return this.memory.keys();
    }

    public values(): IterableIterator<ObservableLatestValue<V>> {
        return this.memory.values();
    }

    public entriesView(): IterableIterator<[K, ObservableLatestValue<V>]> {
        return this.memory.entriesView();
    }

    public readAllValues(): V[] {
        return this.memory.readAllValues();
    }

    public readable(): ReadableKeyedValues<K, V> {
        return this;
    }

    // ── ObservableKeyedValues delegation ─────────────────────────────────────

    public onCreatedDo(
        listener: ObservableKeyedValueListener<K, V>,
    ): Unsubscribe {
        return this.memory.onCreatedDo(listener);
    }

    public onUpdatedDo(
        listener: ObservableKeyedValueListener<K, V>,
    ): Unsubscribe {
        return this.memory.onUpdatedDo(listener);
    }

    public onRefreshedDo(
        listener: ObservableKeyedValueListener<K, V>,
    ): Unsubscribe {
        return this.memory.onRefreshedDo(listener);
    }

    public onDeletedDo(
        listener: ObservableKeyedValueListener<K, V>,
    ): Unsubscribe {
        return this.memory.onDeletedDo(listener);
    }

    public onChangeDo(
        listener: ObservableKeyedValueListener<K, V>,
    ): Unsubscribe {
        return this.memory.onChangeDo(listener);
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    public async whenIdle(): Promise<void> {
        // Loop until both the in-memory observer queue and the persistence
        // write chain settle in the same pass. Mirroring an event enqueues
        // a write, and a write may happen while the in-memory queue drains.
        while (true) {
            const memoryIdle = this.memory.whenIdle();
            const writes = this.writeChain;
            await Promise.all([memoryIdle, writes]);
            if (writes === this.writeChain) {
                return;
            }
        }
    }

    public async flush(): Promise<void> {
        await this.whenIdle();
    }

    public async dispose(): Promise<void> {
        this.memory.dispose();
        await this.whenIdle();
        this.mirrorSubscription?.unsubscribe();
        this.mirrorSubscription = undefined;
    }
}
