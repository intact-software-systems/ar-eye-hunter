import {
    startExpiredEntryEviction,
    type ExpiredEntryEvictionHandle,
    type ExpiredEntryEvictionOptions,
} from './ExpiredEntryEviction.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { LatestValue, LatestValueOptions, ValueValidityChecker } from './LatestValue.ts';
import { PushKeyedValues, type ReadableKeyedValues, type UpdateIfNewerOptions, } from './RepositoryInterfaces.ts';

export interface LatestRepositoryOptions<V> extends ExpiredEntryEvictionOptions {
    ttlMs?: number;
    isValid?: ValueValidityChecker<V>;
    evictWindowMs?: number;
    evictsPerWindow?: number;
}

export interface AcceptLatestEntryInput<K, V> {
    readonly key: K;
    readonly value: V;
    readonly nowEpochMs: number;
    readonly expireAtEpochMs?: number;
}

const DEFAULT_EVICT_WINDOW_MS = 5_000;
const DEFAULT_EVICTS_PER_WINDOW = 2;
const MIN_EVICT_WINDOW_MS = 4;

export class LatestRepository<K, V> implements PushKeyedValues<K, V> {
    private readonly entries = new Map<K, LatestValue<V>>();
    private readonly defaultValueOptions: LatestValueOptions<V>;
    private readonly expiredEntryEviction?: ExpiredEntryEvictionHandle;
    private readonly evictWindowMs: number;
    private readonly evictsPerWindow: number;

    private evictLimiter: RateLimiter | undefined;
    private evictionRuns = 0;

    public constructor(options: LatestRepositoryOptions<V> = {}) {
        this.defaultValueOptions = {
            ttlMs: options.ttlMs,
            isValid: options.isValid,
        };
        this.evictWindowMs = options.evictWindowMs ?? DEFAULT_EVICT_WINDOW_MS;
        this.evictsPerWindow = options.evictsPerWindow ?? DEFAULT_EVICTS_PER_WINDOW;

        if (!Number.isFinite(this.evictWindowMs) || this.evictWindowMs < MIN_EVICT_WINDOW_MS) {
            throw new Error('evictWindowMs must be a finite number of at least 4');
        }
        if (!Number.isInteger(this.evictsPerWindow) || this.evictsPerWindow < 0) {
            throw new Error('evictsPerWindow must be a non-negative integer');
        }

        this.expiredEntryEviction = startExpiredEntryEviction(
            options,
            () => this.deleteExpired(),
        );
    }

    public acceptAt(input: AcceptLatestEntryInput<K, V>): this {
        this.getOrCreate(input.key)
            .acceptAt(input.value, input.nowEpochMs, input.expireAtEpochMs);
        this.evictExpiredWhenAllowed(input.nowEpochMs);
        return this;
    }

    public readAt(key: K, nowEpochMs: number): V | undefined {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return undefined;
        }

        const value = entry.readAt(nowEpochMs);
        if (value === undefined) {
            this.entries.delete(key);
        }
        return value;
    }

    public readOrAcceptAt(
        input: AcceptLatestEntryInput<K, V> & { readonly create: () => V },
    ): V {
        const existing = this.readAt(input.key, input.nowEpochMs);
        if (existing !== undefined) {
            return existing;
        }

        const created = input.create();
        this.acceptAt({ ...input, value: created });
        return created;
    }

    public expiredAt(key: K, nowEpochMs: number): boolean {
        return this.entries.get(key)?.expiredAt(nowEpochMs) ?? true;
    }

    public deleteExpiredAt(nowEpochMs: number): number {
        let removed = 0;

        for (const [key, entry] of this.entries) {
            if (entry.expiredAt(nowEpochMs)) {
                this.entries.delete(key);
                removed += 1;
            }
        }

        this.evictionRuns += 1;
        return removed;
    }

    public evictExpiredWhenAllowed(nowEpochMs: number): number {
        if (this.evictsPerWindow === 0) {
            return 0;
        }

        this.evictLimiter ??= RateLimiter.initWithTs(
            this.evictWindowMs,
            this.evictsPerWindow,
            nowEpochMs,
        );

        return this.evictLimiter.allowAt(nowEpochMs) ? this.deleteExpiredAt(nowEpochMs) : 0;
    }

    public readEvictionCounts(): Readonly<{ retained: number; evictionRuns: number }> {
        return { retained: this.entries.size, evictionRuns: this.evictionRuns };
    }

    // -------------------------------------------------------
    // Push-oriented API
    // -------------------------------------------------------

    public accept(key: K, value: V): void {
        this.getOrCreate(key).accept(value);
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

    public latest(key: K): LatestValue<V> {
        return this.getOrCreate(key);
    }

    // -------------------------------------------------------
    // Read-oriented API
    // -------------------------------------------------------

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
        return false;
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

        const value = entry.takeIfExpired();
        if (value !== undefined) {
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

    /**
     * Refreshes the recency timestamp for an existing entry without changing its value.
     * Returns false if the key does not exist or the entry has no raw value.
     */
    public touch(key: K): boolean {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }

        return entry.touch();
    }

    /**
     * Updates the current raw value only if the key exists and already has a value.
     * Returns false otherwise.
     */
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

    /**
     * Update the value pointed to by the key
     */
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

    /**
     * Updates the current raw value only if the key exists and already has a value.
     * Returns false otherwise.
     */
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

    // -------------------------------------------------------
    // Repository management
    // -------------------------------------------------------

    public has(key: K): boolean {
        return this.entries.has(key);
    }

    public delete(key: K): boolean {
        return this.entries.delete(key);
    }

    public clear(key: K): void {
        this.entries.delete(key);
    }

    public clearAll(): void {
        this.entries.clear();
    }

    public deleteExpired(): number {
        let removed = 0;

        for (const [key, entry] of this.entries) {
            if (entry.expired()) {
                this.entries.delete(key);
                removed += 1;
            }
        }

        return removed;
    }

    public dispose(): void {
        this.expiredEntryEviction?.dispose();
    }

    public size(): number {
        return this.entries.size;
    }

    public keys(): IterableIterator<K> {
        return this.entries.keys();
    }

    public values(): IterableIterator<LatestValue<V>> {
        return this.entries.values();
    }

    public entriesView(): IterableIterator<[K, LatestValue<V>]> {
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

    public readable(): ReadableKeyedValues<K, V> {
        return this;
    }

    private getOrCreate(key: K): LatestValue<V> {
        let entry = this.entries.get(key);

        if (!entry) {
            entry = new LatestValue<V>(this.defaultValueOptions);
            this.entries.set(key, entry);
        }

        return entry;
    }
}
