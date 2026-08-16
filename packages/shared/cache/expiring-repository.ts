import { RateLimiter } from '../resilience/Resilience.ts';
import { LatestValue, LatestValueOptions } from './LatestValue.ts';

export interface ExpiringRepositoryOptions<V> extends LatestValueOptions<V> {
    evictWindowMs?: number;
    evictsPerWindow?: number;
}

export interface AcceptExpiringEntryInput<K, V> {
    readonly key: K;
    readonly value: V;
    readonly nowEpochMs: number;
    readonly expireAtEpochMs?: number;
}

export interface ExpiringRepositoryCounts {
    readonly retained: number;
    readonly evictionRuns: number;
}

const DEFAULT_EVICT_WINDOW_MS = 5_000;
const DEFAULT_EVICTS_PER_WINDOW = 2;
const MIN_EVICT_WINDOW_MS = 4;

export class ExpiringRepository<K, V> {
    private readonly entries = new Map<K, LatestValue<V>>();
    private readonly options: ExpiringRepositoryOptions<V>;
    private readonly evictWindowMs: number;
    private readonly evictsPerWindow: number;

    private evictLimiter: RateLimiter | undefined;
    private evictionRuns = 0;

    public constructor(options: ExpiringRepositoryOptions<V> = {}) {
        this.options = options;
        this.evictWindowMs = options.evictWindowMs ?? DEFAULT_EVICT_WINDOW_MS;
        this.evictsPerWindow = options.evictsPerWindow ?? DEFAULT_EVICTS_PER_WINDOW;

        if (!Number.isFinite(this.evictWindowMs) || this.evictWindowMs < MIN_EVICT_WINDOW_MS) {
            throw new Error('evictWindowMs must be a finite number of at least 4');
        }
        if (!Number.isInteger(this.evictsPerWindow) || this.evictsPerWindow < 0) {
            throw new Error('evictsPerWindow must be a non-negative integer');
        }
    }

    public accept(input: AcceptExpiringEntryInput<K, V>): this {
        const entry = this.entries.get(input.key) ?? new LatestValue<V>(this.options);
        entry.acceptAt(input.value, input.nowEpochMs, input.expireAtEpochMs);
        this.entries.set(input.key, entry);
        this.evictExpiredWhenAllowed(input.nowEpochMs);
        return this;
    }

    public read(key: K, nowEpochMs: number): V | undefined {
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

    public readOrAccept(
        input: AcceptExpiringEntryInput<K, V> & { readonly create: () => V },
    ): V {
        const existing = this.read(input.key, input.nowEpochMs);
        if (existing !== undefined) {
            return existing;
        }

        const created = input.create();
        this.accept({ ...input, value: created });
        return created;
    }

    public peek(key: K): V | undefined {
        return this.entries.get(key)?.peek();
    }

    public hasLiveValue(key: K, nowEpochMs: number): boolean {
        return this.read(key, nowEpochMs) !== undefined;
    }

    public expired(key: K, nowEpochMs: number): boolean {
        return this.entries.get(key)?.expiredAt(nowEpochMs) ?? true;
    }

    public has(key: K): boolean {
        return this.entries.has(key);
    }

    public delete(key: K): boolean {
        return this.entries.delete(key);
    }

    public clearAll(): void {
        this.entries.clear();
    }

    public deleteExpired(nowEpochMs: number): number {
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

        return this.evictLimiter.allowAt(nowEpochMs) ? this.deleteExpired(nowEpochMs) : 0;
    }

    public keys(): IterableIterator<K> {
        return this.entries.keys();
    }

    public readAllValues(nowEpochMs: number): V[] {
        const values: V[] = [];
        for (const key of [...this.entries.keys()]) {
            const value = this.read(key, nowEpochMs);
            if (value !== undefined) {
                values.push(value);
            }
        }
        return values;
    }

    public size(): number {
        return this.entries.size;
    }

    public readCounts(): ExpiringRepositoryCounts {
        return { retained: this.entries.size, evictionRuns: this.evictionRuns };
    }
}
