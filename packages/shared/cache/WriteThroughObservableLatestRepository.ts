import { NEVER_EXPIRE_AT_TIMESTAMP, type PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import { ObservableLatestRepository, type ObservableLatestRepositoryOptions } from './ObservableLatestRepository.ts';
import type { ObservableLatestValue } from './ObservableLatestValue.ts';
import {
    type ObservableKeyedValueListener,
    type ObservableKeyedValues,
    type Unsubscribe
} from './RepositoryInterfaces.ts';

export type WriteThroughObservableLatestRepositoryOptions<K, V> =
    & ObservableLatestRepositoryOptions<K, V>
    & Readonly<{
        persistence: PersistenceProvider<K, V>;
        /**
         * Maps a written value to its absolute on-disk expiry timestamp.
         * Default: now + ttlMs when ttlMs is set, otherwise NEVER_EXPIRE_AT_TIMESTAMP.
         */
        expireAtFor?: (value: V) => number;
    }>;

/**
 * Write-through cache: writes are committed to the persistence layer first,
 * and the in-memory observable cache is updated only after the disk write
 * resolves. Reads return RAM when present and fall back to disk on cache miss
 * or expiry; the disk-loaded value then re-populates RAM (firing events).
 *
 * - Writes are async and serialized through a single chain to preserve order
 *   under concurrent callers.
 * - Sync read methods (read/peek/has/keys/...) reflect RAM only.
 * - Async get(key) is the canonical "give me the freshest value" call.
 * - Hydrate is optional: get() will lazily fill the cache. Call hydrate() at
 *   startup if you want a warm cache before the first read.
 *
 * Strong points: durable writes, eventual consistency between tabs that share
 * the IDB store. Weak point: each write costs a round-trip to disk before
 * observers fire. Use WriteBehindObservableLatestRepository when write
 * latency or burst throughput matter more than durability.
 */
export class WriteThroughObservableLatestRepository<K, V> implements ObservableKeyedValues<K, V> {
    private readonly memory: ObservableLatestRepository<K, V>;
    private readonly persistence: PersistenceProvider<K, V>;
    private readonly expireAtFor: (value: V) => number;

    private hydrationPromise: Promise<void> | undefined;
    private hydrated = false;
    private writeChain: Promise<void> = Promise.resolve();

    public constructor(
        options: WriteThroughObservableLatestRepositoryOptions<K, V>
    ) {
        this.memory = new ObservableLatestRepository<K, V>(options);
        this.persistence = options.persistence;

        const ttlMs = options.ttlMs;
        this.expireAtFor = options.expireAtFor ?? ((_value) =>
            ttlMs !== undefined && Number.isFinite(ttlMs)
                ? Date.now() + ttlMs
                : NEVER_EXPIRE_AT_TIMESTAMP);
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    public hydrate(): Promise<void> {
        if (!this.hydrationPromise) {
            const load = this.serialize(async () => {
                await this.runHydrate();
            });

            this.hydrationPromise = load.then(async () => {
                await this.memory.whenIdle();
                this.hydrated = true;
            });
        }
        return this.hydrationPromise;
    }

    public whenHydrated(): Promise<void> {
        return this.hydrationPromise ?? Promise.resolve();
    }

    public isHydrated(): boolean {
        return this.hydrated;
    }

    private async runHydrate(): Promise<void> {
        const keys = await this.persistence.getAllKeys();
        for (const key of keys) {
            const value = await this.persistence.getItem(key);
            if (value !== undefined) {
                this.memory.accept(key, value);
            }
        }
    }

    public async whenIdle(): Promise<void> {
        // Drain pending writes first, then observer work those writes queued.
        // Loop because new writes can be submitted while observers drain.
        while (true) {
            const writes = this.writeChain;
            await writes;
            await this.memory.whenIdle();
            if (writes === this.writeChain) {
                return;
            }
        }
    }

    public flush(): Promise<void> {
        return this.whenIdle();
    }

    public async dispose(): Promise<void> {
        this.memory.dispose();
        await this.whenIdle();
    }

    // ── write API: async, DB-first, serialized ───────────────────────────────

    public accept(key: K, value: V): Promise<void> {
        return this.serialize(async () => {
            await this.persistence.setItem(key, value, {
                expireAtTimestamp: this.expireAtFor(value)
            });
            this.memory.accept(key, value);
        });
    }

    public async set(key: K, value: V): Promise<this> {
        await this.accept(key, value);
        return this;
    }

    public delete(key: K): Promise<boolean> {
        return this.serialize(async () => {
            await this.persistence.removeItem(key);
            return this.memory.delete(key);
        });
    }

    public clearAll(): Promise<void> {
        return this.serialize(async () => {
            const keys = await this.persistence.getAllKeys();
            await Promise.all(
                keys.map((key) => this.persistence.removeItem(key))
            );
            this.memory.clearAll();
        });
    }

    private serialize<R>(operation: () => Promise<R>): Promise<R> {
        const next = this.writeChain.then(operation, operation);
        // Keep the chain alive on errors so subsequent writes still serialize.
        this.writeChain = next.then(noop, noop);
        return next;
    }

    // ── sync read API: RAM-only ──────────────────────────────────────────────

    public read(key: K): V | undefined {
        return this.memory.read(key);
    }

    public peek(key: K): V | undefined {
        return this.memory.peek(key);
    }

    public hasValue(key: K): boolean {
        return this.memory.hasValue(key);
    }

    public expired(key: K): boolean {
        return this.memory.expired(key);
    }

    public has(key: K): boolean {
        return this.memory.has(key);
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

    // ── async read-through API: RAM with disk fallback ───────────────────────

    /**
     * Returns the freshest known value for the key.
     *
     * - Returns the RAM value when present and not expired.
     * - On cache miss / expiry: fetches from disk. If found, populates RAM
     *   (which fires Created/Updated events) and returns the value.
     * - Returns undefined if the key is absent both in RAM and on disk.
     *
     * Concurrent writes are observed: if a write committed while we waited
     * on disk, the second RAM check returns the just-committed value rather
     * than the stale disk read.
     */
    public async get(key: K): Promise<V | undefined> {
        const fromRam = this.memory.read(key);
        if (fromRam !== undefined) {
            return fromRam;
        }

        const fromDisk = await this.persistence.getItem(key);
        const fresh = this.memory.read(key);
        if (fresh !== undefined) {
            return fresh;
        }

        if (fromDisk === undefined) {
            return undefined;
        }

        this.memory.accept(key, fromDisk);
        return fromDisk;
    }

    /**
     * Returns every value present in RAM plus any disk-only values. Always
     * goes to disk to ensure completeness; updates RAM with disk-only values.
     */
    public async getAll(): Promise<V[]> {
        const keys = await this.persistence.getAllKeys();
        const results: V[] = [];
        for (const key of keys) {
            const value = await this.get(key);
            if (value !== undefined) {
                results.push(value);
            }
        }
        return results;
    }

    // ── observers: delegated unchanged ───────────────────────────────────────

    public onCreatedDo(
        listener: ObservableKeyedValueListener<K, V>
    ): Unsubscribe {
        return this.memory.onCreatedDo(listener);
    }

    public onUpdatedDo(
        listener: ObservableKeyedValueListener<K, V>
    ): Unsubscribe {
        return this.memory.onUpdatedDo(listener);
    }

    public onRefreshedDo(
        listener: ObservableKeyedValueListener<K, V>
    ): Unsubscribe {
        return this.memory.onRefreshedDo(listener);
    }

    public onDeletedDo(
        listener: ObservableKeyedValueListener<K, V>
    ): Unsubscribe {
        return this.memory.onDeletedDo(listener);
    }

    public onChangeDo(
        listener: ObservableKeyedValueListener<K, V>
    ): Unsubscribe {
        return this.memory.onChangeDo(listener);
    }
}

function noop(): void {
    // intentional: keep the write chain alive across rejections
}
