import { LatestValue, LatestValueOptions } from './LatestValue.ts';
import { ReadableValue } from './ReadableValue.ts';

export interface LatestMementoOptions<T> extends LatestValueOptions<T> {
    undoDepth?: number;
    redoDepth?: number;
}

export interface LatestMementoSnapshot<T> {
    current: LatestValue<T> | undefined;
    undos: T[];
    redos: T[];
    undoDepth: number;
    redoDepth: number;
    defaultLatestOptions: LatestValueOptions<T>;
}

const DEFAULT_UNDO_DEPTH = 10;
const DEFAULT_REDO_DEPTH = 10;

export class LatestMementoValue<T> implements ReadableValue<T> {
    private current: LatestValue<T> | undefined;
    private readonly undos: T[] = [];
    private readonly redos: T[] = [];
    private readonly undoDepth: number;
    private readonly redoDepth: number;
    private readonly defaultLatestOptions: LatestValueOptions<T>;

    public constructor(
        current?: LatestValue<T>,
        options: LatestMementoOptions<T> = {}
    ) {
        this.current = current;
        this.undoDepth = options.undoDepth ?? DEFAULT_UNDO_DEPTH;
        this.redoDepth = options.redoDepth ?? DEFAULT_REDO_DEPTH;
        this.defaultLatestOptions = {
            ttlMs: options.ttlMs,
            isValid: options.isValid
        };

        if (!Number.isInteger(this.undoDepth) || this.undoDepth < 0) {
            throw new Error('undoDepth must be an integer >= 0');
        }

        if (!Number.isInteger(this.redoDepth) || this.redoDepth < 0) {
            throw new Error('redoDepth must be an integer >= 0');
        }
    }

    public static empty<T>(
        options: LatestMementoOptions<T> = {}
    ): LatestMementoValue<T> {
        return new LatestMementoValue<T>(undefined, options);
    }

    public static fromLatest<T>(
        latest: LatestValue<T>,
        options: LatestMementoOptions<T> = {}
    ): LatestMementoValue<T> {
        return new LatestMementoValue<T>(latest, options);
    }

    public static fromValue<T>(
        value: T,
        options: LatestMementoOptions<T> = {}
    ): LatestMementoValue<T> {
        return new LatestMementoValue<T>(
            LatestMementoValue.fixedLatest(value, options),
            options
        );
    }

    public static fromSnapshot<T>(
        snapshot: LatestMementoSnapshot<T>
    ): LatestMementoValue<T> {
        const instance = new LatestMementoValue<T>(snapshot.current, {
            undoDepth: snapshot.undoDepth,
            redoDepth: snapshot.redoDepth,
            ttlMs: snapshot.defaultLatestOptions.ttlMs,
            isValid: snapshot.defaultLatestOptions.isValid
        });

        instance.undos.push(...snapshot.undos);
        instance.redos.push(...snapshot.redos);

        return instance;
    }

    public copy(): LatestMementoValue<T> {
        return LatestMementoValue.fromSnapshot(this.snapshot());
    }

    public snapshot(): LatestMementoSnapshot<T> {
        return {
            current: this.current,
            undos: [...this.undos],
            redos: [...this.redos],
            undoDepth: this.undoDepth,
            redoDepth: this.redoDepth,
            defaultLatestOptions: { ...this.defaultLatestOptions }
        };
    }

    // -------------------------------------------------------
    // LatestValue-like API
    // -------------------------------------------------------

    public present(): LatestValue<T> | undefined {
        return this.current;
    }

    public currentLatest(): LatestValue<T> | undefined {
        return this.current;
    }

    public read(): T | undefined {
        return this.current?.read();
    }

    public peek(): T | undefined {
        return this.current?.peek();
    }

    public get(): T {
        return this.requireCurrent().get();
    }

    public accept(value: T): void {
        this.captureCurrentIntoUndo();
        this.requireCurrentOrCreate().accept(value);
        this.redos.length = 0;
    }

    public next(value: T): void {
        this.accept(value);
    }

    public set(value: T): this {
        this.accept(value);
        return this;
    }

    public asCallback(): (value: T) => void {
        return (value: T) => {
            this.accept(value);
        };
    }

    public getOrElse(fallback: T): T {
        return this.current?.getOrElse(fallback) ?? fallback;
    }

    public getOrElseGet(factory: () => T): T {
        return this.current?.getOrElseGet(factory) ?? factory();
    }

    public compareAndSet(expect: T | undefined, update: T): boolean {
        const current = this.current;
        if (!current) {
            return false;
        }

        if (!Object.is(current.peek(), expect)) {
            return false;
        }

        this.captureCurrentIntoUndo();
        current.set(update);
        this.redos.length = 0;
        return true;
    }

    public getAndSet(update: T): T | undefined {
        const previous = this.current?.peek();
        this.captureCurrentIntoUndo();
        this.requireCurrentOrCreate().set(update);
        this.redos.length = 0;
        return previous;
    }

    public take(): T | undefined {
        const current = this.current?.take();
        return current;
    }

    public takeIfExpired(): T | undefined {
        return this.current?.takeIfExpired();
    }

    public hasValue(): boolean {
        return this.current?.hasValue() ?? false;
    }

    public expired(): boolean {
        return this.current?.expired() ?? true;
    }

    public refreshing(): boolean {
        return false;
    }

    public clearCurrent(): this {
        this.current = undefined;
        return this;
    }

    public clear(): void {
        this.current?.clear();
    }

    // -------------------------------------------------------
    // Memento API
    // -------------------------------------------------------

    /**
     * Replace the current LatestValue holder.
     * Previous current raw value is pushed to undo stack if available.
     * Redo stack is cleared.
     */
    public setLatest(latest: LatestValue<T> | undefined): this {
        this.captureCurrentIntoUndo();
        this.current = latest;
        this.redos.length = 0;
        return this;
    }

    public commitLatest(latest: LatestValue<T> | undefined): this {
        return this.setLatest(latest);
    }

    /**
     * Replace current with a fixed-value LatestValue holder.
     */
    public setValue(
        value: T,
        options: LatestValueOptions<T> = this.defaultLatestOptions
    ): this {
        return this.setLatest(LatestMementoValue.fixedLatest(value, options));
    }

    public commitValue(
        value: T,
        options: LatestValueOptions<T> = this.defaultLatestOptions
    ): this {
        return this.setValue(value, options);
    }

    public getAndSetLatest(
        latest: LatestValue<T> | undefined
    ): LatestValue<T> | undefined {
        const previous = this.current;
        this.captureCurrentIntoUndo();
        this.current = latest;
        this.redos.length = 0;
        return previous;
    }

    public compareAndSetLatest(
        expect: LatestValue<T> | undefined,
        update: LatestValue<T> | undefined
    ): boolean {
        if (this.current !== expect) {
            return false;
        }

        this.captureCurrentIntoUndo();
        this.current = update;
        this.redos.length = 0;
        return true;
    }

    /**
     * Undo to previous raw value by wrapping it in a fixed LatestValue.
     * Current raw value is pushed to redo stack if available.
     */
    public undo(): T | undefined {
        const nextValue = this.undos.shift();
        if (nextValue === undefined) {
            return undefined;
        }

        this.captureCurrentIntoRedo();
        this.current = LatestMementoValue.fixedLatest<T>(
            nextValue,
            this.defaultLatestOptions
        );
        return nextValue;
    }

    /**
     * Redo to next raw value by wrapping it in a fixed LatestValue.
     * Current raw value is pushed to undo stack if available.
     */
    public redo(): T | undefined {
        const nextValue = this.redos.shift();
        if (nextValue === undefined) {
            return undefined;
        }

        this.captureCurrentIntoUndo();
        this.current = LatestMementoValue.fixedLatest<T>(
            nextValue,
            this.defaultLatestOptions
        );
        return nextValue;
    }

    public undoStack(): readonly T[] {
        return [...this.undos];
    }

    public redoStack(): readonly T[] {
        return [...this.redos];
    }

    public canUndo(): boolean {
        return this.undos.length > 0;
    }

    public canRedo(): boolean {
        return this.redos.length > 0;
    }

    public clearUndo(): this {
        this.undos.length = 0;
        return this;
    }

    public clearRedo(): this {
        this.redos.length = 0;
        return this;
    }

    public clearAll(): this {
        this.current = undefined;
        this.undos.length = 0;
        this.redos.length = 0;
        return this;
    }

    public isUndoStackEmpty(): boolean {
        return this.undos.length === 0;
    }

    public isRedoStackEmpty(): boolean {
        return this.redos.length === 0;
    }

    public isAllEmpty(): boolean {
        return (
            this.current === undefined &&
            this.undos.length === 0 &&
            this.redos.length === 0
        );
    }

    // -------------------------------------------------------
    // Peek helpers for undo/redo values
    // -------------------------------------------------------

    public peekUndoValue(): T | undefined {
        return this.undos[0];
    }

    public peekRedoValue(): T | undefined {
        return this.redos[0];
    }

    public peekUndoValueAt(index: number): T | undefined {
        return this.undos[index];
    }

    public peekRedoValueAt(index: number): T | undefined {
        return this.redos[index];
    }

    public undoDepthUsed(): number {
        return this.undos.length;
    }

    public redoDepthUsed(): number {
        return this.redos.length;
    }

    private requireCurrent(): LatestValue<T> {
        if (!this.current) {
            throw new Error('No current LatestValue');
        }
        return this.current;
    }

    private requireCurrentOrCreate(): LatestValue<T> {
        if (!this.current) {
            this.current = new LatestValue<T>(this.defaultLatestOptions);
        }
        return this.current;
    }

    private captureCurrentIntoUndo(): void {
        this.pushUndo(this.current?.peek());
    }

    private captureCurrentIntoRedo(): void {
        this.pushRedo(this.current?.peek());
    }

    private pushUndo(value: T | undefined): void {
        if (value === undefined || this.undoDepth === 0) {
            return;
        }

        this.undos.unshift(value);
        this.trimToDepth(this.undos, this.undoDepth);
    }

    private pushRedo(value: T | undefined): void {
        if (value === undefined || this.redoDepth === 0) {
            return;
        }

        this.redos.unshift(value);
        this.trimToDepth(this.redos, this.redoDepth);
    }

    private trimToDepth<U>(stack: U[], depth: number): void {
        if (stack.length > depth) {
            stack.length = depth;
        }
    }

    private static fixedLatest<T>(
        value: T,
        options: LatestValueOptions<T> = {}
    ): LatestValue<T> {
        const latest = new LatestValue<T>(options);
        latest.accept(value);
        return latest;
    }
}
