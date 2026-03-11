import { LatestMementoOptions, LatestMementoValue, } from './LatestMementoValue.ts';
import { LatestValue, LatestValueOptions } from './LatestValue.ts';
import { PushMementoKeyedValues } from './RepositoryInterfaces.ts';

export interface LatestMementoRepositoryOptions<V>
    extends LatestMementoOptions<V> {
}

export class LatestMementoRepository<K, V> implements PushMementoKeyedValues<K, V> {
    private readonly entries = new Map<K, LatestMementoValue<V>>();
    private readonly defaultOptions: LatestMementoOptions<V>;

    public constructor(
        options: LatestMementoRepositoryOptions<V> = {},
    ) {
        this.defaultOptions = {
            ttlMs: options.ttlMs,
            isValid: options.isValid,
            undoDepth: options.undoDepth,
            redoDepth: options.redoDepth,
        };
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

    /**
     * Pushes a new value for this key and records per-key history.
     */
    public commitValue(
        key: K,
        value: V,
        options: LatestValueOptions<V> = this.defaultOptions,
    ): this {
        this.getOrCreate(key).commitValue(value, options);
        return this;
    }

    /**
     * Replaces the current LatestValue holder for this key.
     */
    public commitLatest(
        key: K,
        latest: LatestValue<V> | undefined,
    ): this {
        this.getOrCreate(key).commitLatest(latest);
        return this;
    }

    /**
     * Returns a callback that writes into the per-key LatestMementoValue.
     * Because LatestMementoValue.accept() captures history, each callback push
     * becomes an undo step for that key.
     */
    public asCallback(key: K): (value: V) => void {
        return (value: V) => {
            this.accept(key, value);
        };
    }

    /**
     * Access the per-key LatestMementoValue holder directly.
     */
    public latestMemento(key: K): LatestMementoValue<V> {
        return this.getOrCreate(key);
    }

    /**
     * Access the current LatestValue holder for a key, if any.
     */
    public latest(key: K): LatestValue<V> | undefined {
        return this.entries.get(key)?.currentLatest();
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

    public compareAndSet(key: K, expect: V | undefined, update: V): boolean {
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }
        return entry.compareAndSet(expect, update);
    }

    public getAndSet(key: K, update: V): V | undefined {
        return this.getOrCreate(key).getAndSet(update);
    }

    public touch(key: K): boolean {
        const latest = this.entries.get(key)?.currentLatest();
        if (!latest) {
            return false;
        }
        return latest.touch();
    }

    public updateIfPresent(
        key: K,
        updater: (current: V) => V,
    ): boolean {
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

    public setIfAbsent(key: K, creator: () => V): V {
        const entry = this.getOrCreate(key);
        const existing = entry.read();

        if (existing !== undefined) {
            return existing;
        }

        const value = creator();
        entry.set(value);
        return value;
    }

    public take(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }

        const value = entry.currentLatest()?.take();
        this.entries.delete(key);
        return value;
    }

    public takeIfExpired(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }

        const value = entry.currentLatest()?.takeIfExpired();
        if (value !== undefined) {
            this.entries.delete(key);
        }
        return value;
    }

    // -------------------------------------------------------
    // Per-key memento API
    // -------------------------------------------------------

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
     * Deletes keys whose current LatestValue is expired.
     */
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

    public size(): number {
        return this.entries.size;
    }

    public keys(): IterableIterator<K> {
        return this.entries.keys();
    }

    public values(): IterableIterator<LatestMementoValue<V>> {
        return this.entries.values();
    }

    public entriesView(): IterableIterator<[K, LatestMementoValue<V>]> {
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

    private getOrCreate(key: K): LatestMementoValue<V> {
        let entry = this.entries.get(key);

        if (!entry) {
            entry = LatestMementoValue.empty<V>(this.defaultOptions);
            this.entries.set(key, entry);
        }

        return entry;
    }
}
