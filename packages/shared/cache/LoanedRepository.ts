import { LoanedValue, LoanedValueOptions, LoanedValueValidityChecker, } from './LoanedValue.ts';
import { PullKeyedValues } from './RepositoryInterfaces.ts';

export type CachedRepositoryRefresh<K, V> = (
    key: K,
    current: V | undefined,
) => V | Promise<V>;

export interface CachedRepositoryOptions<V> {
    ttlMs?: number;
    isValid?: LoanedValueValidityChecker<V>;
}

export class LoanedRepository<K, V> implements PullKeyedValues<K, V> {
    private readonly entries = new Map<K, LoanedValue<V>>();

    private readonly refresher: CachedRepositoryRefresh<K, V>;
    private readonly options: CachedRepositoryOptions<V>;

    public constructor(
        refresher: CachedRepositoryRefresh<K, V>,
        options: CachedRepositoryOptions<V> = {},
    ) {
        this.refresher = refresher;
        this.options = options;
        if (!refresher) {
            throw new Error('refresher is required');
        }
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
        refresher: CachedRepositoryRefresh<K, V>,
    ): Promise<V> {
        return this.getOrCreate(key).getWith((current) => refresher(key, current));
    }

    public async refresh(key: K): Promise<V> {
        return this.getOrCreate(key).refresh();
    }

    public async refreshWith(
        key: K,
        refresher: CachedRepositoryRefresh<K, V>,
    ): Promise<V> {
        return this.getOrCreate(key).refreshWith((current) => refresher(key, current));
    }

    public take(key: K): V | undefined {
        const value = this.entries.get(key)?.take();
        this.entries.delete(key);
        return value;
    }

    public takeIfExpired(key: K): V | undefined {
        const value = this.entries.get(key)?.takeIfExpired();
        if (value !== undefined) {
            this.entries.delete(key);
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
        return this.entries.delete(key);
    }

    public clear(key: K): void {
        this.entries.delete(key);
    }

    public clearAll(): void {
        this.entries.clear();
    }

    /**
     * Deletes entries whose current value is expired.
     *
     * Returns the number of removed keys.
     */
    public deleteExpired(): number {
        let removed = 0;

        for (const [key, entry] of this.entries) {
            if (!entry.refreshing() && entry.expired()) {
                this.entries.delete(key);
                removed += 1;
            }
        }

        return removed;
    }

    public keys(): IterableIterator<K> {
        return this.entries.keys();
    }

    public values(): IterableIterator<LoanedValue<V>> {
        return this.entries.values();
    }

    public entriesView(): IterableIterator<[K, LoanedValue<V>]> {
        return this.entries.entries();
    }

    public size(): number {
        return this.entries.size;
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

    private getOrCreate(key: K): LoanedValue<V> {
        let entry = this.entries.get(key);

        if (!entry) {
            const loanOptions: LoanedValueOptions<V> = {
                ttlMs: this.options.ttlMs,
                isValid: this.options.isValid,
            };

            entry = new LoanedValue<V>(
                (current) => this.refresher(key, current),
                loanOptions,
            );

            this.entries.set(key, entry);
        }

        return entry;
    }
}