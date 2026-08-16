import { LatestValue, LatestValueOptions } from './LatestValue.ts';

export interface ExpiringRepositoryOptions<V> extends LatestValueOptions<V> {
    pruneWindowMs?: number;
    prunesPerWindow?: number;
}

export interface AcceptExpiringEntryInput<K, V> {
    readonly key: K;
    readonly value: V;
    readonly nowEpochMs: number;
    readonly expireAtEpochMs?: number;
}

export interface ExpiringRepositoryCounts {
    readonly retained: number;
    readonly pruneRuns: number;
}

const DEFAULT_PRUNE_WINDOW_MS = 5_000;
const DEFAULT_PRUNES_PER_WINDOW = 2;

export class ExpiringRepository<K, V> {
    private readonly entries = new Map<K, LatestValue<V>>();
    private readonly options: ExpiringRepositoryOptions<V>;
    private readonly pruneWindowMs: number;
    private readonly prunesPerWindow: number;

    private pruneWindowStartMs: number | undefined;
    private prunesInWindow = 0;
    private pruneRuns = 0;

    public constructor(options: ExpiringRepositoryOptions<V> = {}) {
        this.options = options;
        this.pruneWindowMs = options.pruneWindowMs ?? DEFAULT_PRUNE_WINDOW_MS;
        this.prunesPerWindow = options.prunesPerWindow ?? DEFAULT_PRUNES_PER_WINDOW;

        if (!Number.isFinite(this.pruneWindowMs) || this.pruneWindowMs < 0) {
            throw new Error('pruneWindowMs must be a finite non-negative number');
        }
        if (!Number.isInteger(this.prunesPerWindow) || this.prunesPerWindow < 1) {
            throw new Error('prunesPerWindow must be a positive integer');
        }
    }

    public accept(input: AcceptExpiringEntryInput<K, V>): this {
        const entry = this.entries.get(input.key) ?? new LatestValue<V>(this.options);
        entry.acceptAt(input.value, input.nowEpochMs, input.expireAtEpochMs);
        this.entries.set(input.key, entry);
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
        this.pruneRuns += 1;
        return removed;
    }

    public deleteExpiredWhenDue(nowEpochMs: number): number {
        if (!this.isPruneDue(nowEpochMs)) {
            return 0;
        }
        return this.deleteExpired(nowEpochMs);
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
        return { retained: this.entries.size, pruneRuns: this.pruneRuns };
    }

    private isPruneDue(nowEpochMs: number): boolean {
        if (
            this.pruneWindowStartMs === undefined ||
            nowEpochMs - this.pruneWindowStartMs >= this.pruneWindowMs
        ) {
            this.pruneWindowStartMs = nowEpochMs;
            this.prunesInWindow = 1;
            return true;
        }

        if (this.prunesInWindow >= this.prunesPerWindow) {
            return false;
        }

        this.prunesInWindow += 1;
        return true;
    }
}
