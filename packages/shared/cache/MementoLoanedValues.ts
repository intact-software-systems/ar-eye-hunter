import { LoanedValue, LoanedValueOptions, LoanedValueRefresh } from './LoanedValue.ts';

export interface MementoLoanedOptions<T> extends LoanedValueOptions<T> {
    undoDepth?: number;
    redoDepth?: number;
}

export interface MementoLoanedSnapshot<T> {
    current: LoanedValue<T> | undefined;
    undos: LoanedValue<T>[];
    redos: LoanedValue<T>[];
    undoDepth: number;
    redoDepth: number;
    defaultLoanOptions: LoanedValueOptions<T>;
}

const DEFAULT_UNDO_DEPTH = 10;
const DEFAULT_REDO_DEPTH = 10;

export class MementoLoanedValue<T> {
    private current: LoanedValue<T> | undefined;
    private readonly undos: Array<LoanedValue<T>> = [];
    private readonly redos: Array<LoanedValue<T>> = [];
    private readonly undoDepth: number;
    private readonly redoDepth: number;
    private readonly defaultLoanOptions: LoanedValueOptions<T>;

    public constructor(
        current?: LoanedValue<T>,
        options: MementoLoanedOptions<T> = {}
    ) {
        this.current = current;
        this.undoDepth = options.undoDepth ?? DEFAULT_UNDO_DEPTH;
        this.redoDepth = options.redoDepth ?? DEFAULT_REDO_DEPTH;
        this.defaultLoanOptions = {
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
        options: MementoLoanedOptions<T> = {}
    ): MementoLoanedValue<T> {
        return new MementoLoanedValue<T>(undefined, options);
    }

    public static fromRefresher<T>(
        refresher: LoanedValueRefresh<T>,
        options: MementoLoanedOptions<T> = {}
    ): MementoLoanedValue<T> {
        return new MementoLoanedValue<T>(
            new LoanedValue<T>(refresher, options),
            options
        );
    }

    public static fromValue<T>(
        value: T,
        options: MementoLoanedOptions<T> = {}
    ): MementoLoanedValue<T> {
        return new MementoLoanedValue<T>(
            MementoLoanedValue.fixedLoan(value, options),
            options
        );
    }

    public static fromSnapshot<T>(
        snapshot: MementoLoanedSnapshot<T>
    ): MementoLoanedValue<T> {
        const instance = new MementoLoanedValue<T>(snapshot.current, {
            undoDepth: snapshot.undoDepth,
            redoDepth: snapshot.redoDepth,
            ttlMs: snapshot.defaultLoanOptions.ttlMs,
            isValid: snapshot.defaultLoanOptions.isValid
        });

        instance.undos.push(...snapshot.undos);
        instance.redos.push(...snapshot.redos);

        return instance;
    }

    public copy(): MementoLoanedValue<T> {
        return MementoLoanedValue.fromSnapshot(this.snapshot());
    }

    public snapshot(): MementoLoanedSnapshot<T> {
        return {
            current: this.current,
            undos: [...this.undos],
            redos: [...this.redos],
            undoDepth: this.undoDepth,
            redoDepth: this.redoDepth,
            defaultLoanOptions: { ...this.defaultLoanOptions }
        };
    }

    // -------------------------------------------------------
    // LoanedValue-like API
    // -------------------------------------------------------

    public present(): LoanedValue<T> | undefined {
        return this.current;
    }

    public currentLoan(): LoanedValue<T> | undefined {
        return this.current;
    }

    public read(): T | undefined {
        return this.current?.read();
    }

    public peek(): T | undefined {
        return this.current?.peek();
    }

    public async get(): Promise<T> {
        return this.requireCurrent().get();
    }

    public async getWith(refresher: LoanedValueRefresh<T>): Promise<T> {
        return this.requireCurrent().getWith(refresher);
    }

    public async refresh(): Promise<T> {
        return this.requireCurrent().refresh();
    }

    public async refreshWith(refresher: LoanedValueRefresh<T>): Promise<T> {
        return this.requireCurrent().refreshWith(refresher);
    }

    public hasValue(): boolean {
        return this.current?.hasValue() ?? false;
    }

    public expired(): boolean {
        return this.current?.expired() ?? true;
    }

    public refreshing(): boolean {
        return this.current?.refreshing() ?? false;
    }

    public clearCurrent(): this {
        this.current = undefined;
        return this;
    }

    // -------------------------------------------------------
    // Memento API for LoanedValue<T>
    // -------------------------------------------------------

    public setLoan(loan: LoanedValue<T>): this {
        this.pushUndo(this.current);
        this.current = loan;
        this.redos.length = 0;
        return this;
    }

    public commitLoan(loan: LoanedValue<T>): this {
        return this.setLoan(loan);
    }

    public setRefresher(
        refresher: LoanedValueRefresh<T>,
        options: LoanedValueOptions<T> = this.defaultLoanOptions
    ): this {
        return this.setLoan(new LoanedValue<T>(refresher, options));
    }

    public commitRefresher(
        refresher: LoanedValueRefresh<T>,
        options: LoanedValueOptions<T> = this.defaultLoanOptions
    ): this {
        return this.setRefresher(refresher, options);
    }

    public setValue(
        value: T,
        options: LoanedValueOptions<T> = this.defaultLoanOptions
    ): this {
        return this.setLoan(MementoLoanedValue.fixedLoan(value, options));
    }

    public commitValue(
        value: T,
        options: LoanedValueOptions<T> = this.defaultLoanOptions
    ): this {
        return this.setValue(value, options);
    }

    public compareAndSetLoan(
        expect: LoanedValue<T> | undefined,
        update: LoanedValue<T> | undefined
    ): boolean {
        if (this.current !== expect) {
            return false;
        }

        this.pushUndo(this.current);
        this.current = update;
        this.redos.length = 0;
        return true;
    }

    public getAndSetLoan(
        loan: LoanedValue<T> | undefined
    ): LoanedValue<T> | undefined {
        const previous = this.current;
        this.pushUndo(previous);
        this.current = loan;
        this.redos.length = 0;
        return previous;
    }

    public undo(): LoanedValue<T> | undefined {
        const nextCurrent = this.undos.shift();
        if (nextCurrent === undefined) {
            return undefined;
        }

        this.pushRedo(this.current);
        this.current = nextCurrent;
        return this.current;
    }

    public redo(): LoanedValue<T> | undefined {
        const nextCurrent = this.redos.shift();
        if (nextCurrent === undefined) {
            return undefined;
        }

        this.pushUndo(this.current);
        this.current = nextCurrent;
        return this.current;
    }

    public undoStack(): readonly LoanedValue<T>[] {
        return [...this.undos];
    }

    public redoStack(): readonly LoanedValue<T>[] {
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
    // Peek helpers for undo/redo without changing current loan
    // -------------------------------------------------------

    /**
     * Peek the next undo loan object, if any.
     */
    public peekUndoLoan(): LoanedValue<T> | undefined {
        return this.undos[0];
    }

    /**
     * Peek the next redo loan object, if any.
     */
    public peekRedoLoan(): LoanedValue<T> | undefined {
        return this.redos[0];
    }

    /**
     * Peek the next undo raw value via LoanedValue.peek(), if any.
     * Does not trigger refresh.
     */
    public peekUndoValue(): T | undefined {
        return this.undos[0]?.peek();
    }

    /**
     * Peek the next redo raw value via LoanedValue.peek(), if any.
     * Does not trigger refresh.
     */
    public peekRedoValue(): T | undefined {
        return this.redos[0]?.peek();
    }

    /**
     * Peek the next undo readable value via LoanedValue.read(), if any.
     * Returns undefined if missing or expired.
     */
    public readUndoValue(): T | undefined {
        return this.undos[0]?.read();
    }

    /**
     * Peek the next redo readable value via LoanedValue.read(), if any.
     * Returns undefined if missing or expired.
     */
    public readRedoValue(): T | undefined {
        return this.redos[0]?.read();
    }

    /**
     * Peek an undo loan by index, newest first.
     */
    public peekUndoLoanAt(index: number): LoanedValue<T> | undefined {
        return this.undos[index];
    }

    /**
     * Peek a redo loan by index, newest first.
     */
    public peekRedoLoanAt(index: number): LoanedValue<T> | undefined {
        return this.redos[index];
    }

    /**
     * Peek an undo raw value by index, newest first.
     */
    public peekUndoValueAt(index: number): T | undefined {
        return this.undos[index]?.peek();
    }

    /**
     * Peek a redo raw value by index, newest first.
     */
    public peekRedoValueAt(index: number): T | undefined {
        return this.redos[index]?.peek();
    }

    /**
     * Read an undo readable value by index, newest first.
     */
    public readUndoValueAt(index: number): T | undefined {
        return this.undos[index]?.read();
    }

    /**
     * Read a redo readable value by index, newest first.
     */
    public readRedoValueAt(index: number): T | undefined {
        return this.redos[index]?.read();
    }

    /**
     * Resolves the current loan to a value and commits that value
     * as a fixed LoanedValue<T>. This creates a point-in-time snapshot.
     */
    public async snapshotCurrentValueIntoHistory(
        options: LoanedValueOptions<T> = this.defaultLoanOptions
    ): Promise<this> {
        const current = this.requireCurrent();
        const resolved = await current.get();
        return this.setLoan(MementoLoanedValue.fixedLoan<T>(resolved, options));
    }

    private requireCurrent(): LoanedValue<T> {
        if (!this.current) {
            throw new Error('No current LoanedValue');
        }
        return this.current;
    }

    private pushUndo(loan: LoanedValue<T> | undefined): void {
        if (!loan || this.undoDepth === 0) {
            return;
        }

        this.undos.unshift(loan);
        this.trimToDepth(this.undos, this.undoDepth);
    }

    private pushRedo(loan: LoanedValue<T> | undefined): void {
        if (!loan || this.redoDepth === 0) {
            return;
        }

        this.redos.unshift(loan);
        this.trimToDepth(this.redos, this.redoDepth);
    }

    private trimToDepth<U>(stack: U[], depth: number): void {
        if (stack.length > depth) {
            stack.length = depth;
        }
    }

    private static fixedLoan<T>(
        value: T,
        options: LoanedValueOptions<T> = {}
    ): LoanedValue<T> {
        return new LoanedValue<T>(async () => value, {
            ttlMs: Number.MAX_SAFE_INTEGER,
            isValid: () => true,
            ...options
        });
    }
}
