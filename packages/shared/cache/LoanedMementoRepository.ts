import { LoanedMementoOptions, LoanedMementoValue } from './LoanedMementoValue.ts';
import { LoanedValue, LoanedValueOptions, LoanedValueRefresh } from './LoanedValue.ts';
import { LoanedRepositoryRefresh, PullMementoKeyedValues } from './RepositoryInterfaces.ts';

export interface LoanedMementoRepositoryOptions<V> extends LoanedMementoOptions<V> {
}

export class LoanedMementoRepository<K, V> implements PullMementoKeyedValues<K, V> {
    private readonly entries = new Map<K, LoanedMementoValue<V>>();
    private readonly defaultOptions: LoanedMementoOptions<V>;
    private readonly refresher: LoanedRepositoryRefresh<K, V>;

    public constructor(
        refresher: LoanedRepositoryRefresh<K, V>,
        options: LoanedMementoRepositoryOptions<V> = {}
    ) {
        if (!refresher) {
            throw new Error('refresher is required');
        }

        this.refresher = refresher;
        this.defaultOptions = {
            ttlMs: options.ttlMs,
            isValid: options.isValid,
            undoDepth: options.undoDepth,
            redoDepth: options.redoDepth
        };
    }

    // -------------------------------------------------------
    // Loaned / pull-oriented API
    // -------------------------------------------------------

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

        const value = entry.currentLoan()?.take();
        this.entries.delete(key);
        return value;
    }

    public takeIfExpired(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }

        const value = entry.currentLoan()?.takeIfExpired();
        if (value !== undefined) {
            this.entries.delete(key);
        }
        return value;
    }

    /**
     * Access the per-key LoanedMementoValue holder directly.
     */
    public loanedMemento(key: K): LoanedMementoValue<V> {
        return this.getOrCreate(key);
    }

    /**
     * Access the current LoanedValue holder for a key, if any.
     */
    public loan(key: K): LoanedValue<V> | undefined {
        return this.entries.get(key)?.currentLoan();
    }

    // -------------------------------------------------------
    // Per-key memento API
    // -------------------------------------------------------

    public setLoan(
        key: K,
        loan: LoanedValue<V> | undefined
    ): this {
        this.getOrCreate(key).setLoan(loan);
        return this;
    }

    public commitLoan(
        key: K,
        loan: LoanedValue<V> | undefined
    ): this {
        this.getOrCreate(key).commitLoan(loan);
        return this;
    }

    public setRefresher(
        key: K,
        refresher: LoanedValueRefresh<V>,
        options: LoanedValueOptions<V> = this.defaultOptions
    ): this {
        this.getOrCreate(key).setRefresher(refresher, options);
        return this;
    }

    public commitRefresher(
        key: K,
        refresher: LoanedValueRefresh<V>,
        options: LoanedValueOptions<V> = this.defaultOptions
    ): this {
        this.getOrCreate(key).commitRefresher(refresher, options);
        return this;
    }

    public setValue(
        key: K,
        value: V,
        options: LoanedValueOptions<V> = this.defaultOptions
    ): this {
        this.getOrCreate(key).setValue(value, options);
        return this;
    }

    public commitValue(
        key: K,
        value: V,
        options: LoanedValueOptions<V> = this.defaultOptions
    ): this {
        this.getOrCreate(key).commitValue(value, options);
        return this;
    }

    public compareAndSetLoan(
        key: K,
        expect: LoanedValue<V> | undefined,
        update: LoanedValue<V> | undefined
    ): boolean {
        return this.getOrCreate(key).compareAndSetLoan(expect, update);
    }

    public getAndSetLoan(
        key: K,
        loan: LoanedValue<V> | undefined
    ): LoanedValue<V> | undefined {
        return this.getOrCreate(key).getAndSetLoan(loan);
    }

    public undo(key: K): V | undefined {
        return this.entries.get(key)?.undo();
    }

    public redo(key: K): V | undefined {
        return this.entries.get(key)?.redo();
    }

    public canUndo(key: K): boolean {
        return this.entries.get(key)?.canUndo() ?? false;
    }

    public canRedo(key: K): boolean {
        return this.entries.get(key)?.canRedo() ?? false;
    }

    public undoStack(key: K): readonly V[] {
        return this.entries.get(key)?.undoStack() ?? [];
    }

    public redoStack(key: K): readonly V[] {
        return this.entries.get(key)?.redoStack() ?? [];
    }

    public peekUndoValue(key: K): V | undefined {
        return this.entries.get(key)?.peekUndoValue();
    }

    public peekRedoValue(key: K): V | undefined {
        return this.entries.get(key)?.peekRedoValue();
    }

    public peekUndoValueAt(key: K, index: number): V | undefined {
        return this.entries.get(key)?.peekUndoValueAt(index);
    }

    public peekRedoValueAt(key: K, index: number): V | undefined {
        return this.entries.get(key)?.peekRedoValueAt(index);
    }

    public clearUndo(key: K): this {
        this.entries.get(key)?.clearUndo();
        return this;
    }

    public clearRedo(key: K): this {
        this.entries.get(key)?.clearRedo();
        return this;
    }

    public clearHistory(key: K): this {
        const entry = this.entries.get(key);
        if (entry) {
            entry.clearUndo();
            entry.clearRedo();
        }
        return this;
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

    /**
     * Deletes keys whose current LoanedMementoValue is expired and not refreshing.
     */
    public deleteExpired(): number {
        let removed = 0;

        for (const [key, entry] of this.entries) {
            if (entry.refreshing()) {
                continue;
            }

            if (entry.expired()) {
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

    public values(): IterableIterator<LoanedMementoValue<V>> {
        return this.entries.values();
    }

    public entriesView(): IterableIterator<[K, LoanedMementoValue<V>]> {
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

    private getOrCreate(key: K): LoanedMementoValue<V> {
        let entry = this.entries.get(key);

        if (!entry) {
            entry = LoanedMementoValue.empty<V>(this.defaultOptions);
            entry.setRefresher(
                (current) => this.refresher(key, current),
                this.defaultOptions
            );
            this.entries.set(key, entry);
        }

        return entry;
    }
}
