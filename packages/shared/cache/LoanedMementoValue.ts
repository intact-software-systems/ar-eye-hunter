import { LoanedValue, LoanedValueOptions, LoanedValueRefresh, } from './LoanedValue.ts';

export interface LoanedMementoOptions<T> extends LoanedValueOptions<T> {
    undoDepth?: number;
    redoDepth?: number;
}

export interface LoanedMementoSnapshot<T> {
    current: LoanedValue<T> | undefined;
    undos: T[];
    redos: T[];
    undoDepth: number;
    redoDepth: number;
    defaultLoanOptions: LoanedValueOptions<T>;
}

const DEFAULT_UNDO_DEPTH = 10;
const DEFAULT_REDO_DEPTH = 10;

export class LoanedMementoValue<T> {
    private current: LoanedValue<T> | undefined;
    private readonly undos: T[] = [];
    private readonly redos: T[] = [];
    private readonly undoDepth: number;
    private readonly redoDepth: number;
    private readonly defaultLoanOptions: LoanedValueOptions<T>;

    public constructor(
        current?: LoanedValue<T>,
        options: LoanedMementoOptions<T> = {},
    ) {
        this.current = current;
        this.undoDepth = options.undoDepth ?? DEFAULT_UNDO_DEPTH;
        this.redoDepth = options.redoDepth ?? DEFAULT_REDO_DEPTH;
        this.defaultLoanOptions = {
            ttlMs: options.ttlMs,
            isValid: options.isValid,
        };

        if (!Number.isInteger(this.undoDepth) || this.undoDepth < 0) {
            throw new Error('undoDepth must be an integer >= 0');
        }

        if (!Number.isInteger(this.redoDepth) || this.redoDepth < 0) {
            throw new Error('redoDepth must be an integer >= 0');
        }
    }

    public static empty<T>(
        options: LoanedMementoOptions<T> = {},
    ): LoanedMementoValue<T> {
        return new LoanedMementoValue<T>(undefined, options);
    }

    public static fromRefresher<T>(
        refresher: LoanedValueRefresh<T>,
        options: LoanedMementoOptions<T> = {},
    ): LoanedMementoValue<T> {
        return new LoanedMementoValue<T>(
            new LoanedValue<T>(refresher, options),
            options,
        );
    }

    public static fromValue<T>(
        value: T,
        options: LoanedMementoOptions<T> = {},
    ): LoanedMementoValue<T> {
        return new LoanedMementoValue<T>(
            LoanedMementoValue.fixedLoan(value, options),
            options,
        );
    }

    public static fromSnapshot<T>(
        snapshot: LoanedMementoSnapshot<T>,
    ): LoanedMementoValue<T> {
        const instance = new LoanedMementoValue<T>(snapshot.current, {
            undoDepth: snapshot.undoDepth,
            redoDepth: snapshot.redoDepth,
            ttlMs: snapshot.defaultLoanOptions.ttlMs,
            isValid: snapshot.defaultLoanOptions.isValid,
        });

        instance.undos.push(...snapshot.undos);
        instance.redos.push(...snapshot.redos);

        return instance;
    }

    public copy(): LoanedMementoValue<T> {
        return LoanedMementoValue.fromSnapshot(this.snapshot());
    }

    public snapshot(): LoanedMementoSnapshot<T> {
        return {
            current: this.current,
            undos: [...this.undos],
            redos: [...this.redos],
            undoDepth: this.undoDepth,
            redoDepth: this.redoDepth,
            defaultLoanOptions: { ...this.defaultLoanOptions },
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
    // Memento API
    // -------------------------------------------------------

    /**
     * Replace the current loan source.
     * Previous current raw value is pushed to undo stack if already materialized.
     * Redo stack is cleared.
     */
    public setLoan(loan: LoanedValue<T> | undefined): this {
        this.captureCurrentIntoUndo();
        this.current = loan;
        this.redos.length = 0;
        return this;
    }

    public commitLoan(loan: LoanedValue<T> | undefined): this {
        return this.setLoan(loan);
    }

    public setRefresher(
        refresher: LoanedValueRefresh<T>,
        options: LoanedValueOptions<T> = this.defaultLoanOptions,
    ): this {
        return this.setLoan(new LoanedValue<T>(refresher, options));
    }

    public commitRefresher(
        refresher: LoanedValueRefresh<T>,
        options: LoanedValueOptions<T> = this.defaultLoanOptions,
    ): this {
        return this.setRefresher(refresher, options);
    }

    public setValue(
        value: T,
        options: LoanedValueOptions<T> = this.defaultLoanOptions,
    ): this {
        return this.setLoan(LoanedMementoValue.fixedLoan(value, options));
    }

    public commitValue(
        value: T,
        options: LoanedValueOptions<T> = this.defaultLoanOptions,
    ): this {
        return this.setValue(value, options);
    }

    /**
     * Compares by current LoanedValue object identity.
     * If matched, stores previous current raw value into undo stack if materialized.
     */
    public compareAndSetLoan(
        expect: LoanedValue<T> | undefined,
        update: LoanedValue<T> | undefined,
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
     * Replace current loan and return previous current loan.
     */
    public getAndSetLoan(
        loan: LoanedValue<T> | undefined,
    ): LoanedValue<T> | undefined {
        const previous = this.current;
        this.captureCurrentIntoUndo();
        this.current = loan;
        this.redos.length = 0;
        return previous;
    }

    /**
     * Undo to previous raw value by wrapping it in a fixed LoanedValue.
     * Current raw value is pushed to redo stack if already materialized.
     */
    public undo(): T | undefined {
        const nextValue = this.undos.shift();
        if (nextValue === undefined) {
            return undefined;
        }

        this.captureCurrentIntoRedo();
        this.current = LoanedMementoValue.fixedLoan<T>(nextValue, this.defaultLoanOptions);
        return nextValue;
    }

    /**
     * Redo to next raw value by wrapping it in a fixed LoanedValue.
     * Current raw value is pushed to undo stack if already materialized.
     */
    public redo(): T | undefined {
        const nextValue = this.redos.shift();
        if (nextValue === undefined) {
            return undefined;
        }

        this.captureCurrentIntoUndo();
        this.current = LoanedMementoValue.fixedLoan<T>(nextValue, this.defaultLoanOptions);
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

    /**
     * Turn current into a fixed-value loan if it already has a materialized value.
     * Does not trigger refresh.
     */
    public snapshotCurrentAsFixedLoan(
        options: LoanedValueOptions<T> = this.defaultLoanOptions,
    ): this {
        const value = this.current?.peek();
        if (value !== undefined) {
            this.current = LoanedMementoValue.fixedLoan<T>(value, options);
        }
        return this;
    }

    private requireCurrent(): LoanedValue<T> {
        if (!this.current) {
            throw new Error('No current LoanedValue');
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

    private static fixedLoan<T>(
        value: T,
        options: LoanedValueOptions<T> = {},
    ): LoanedValue<T> {
        return new LoanedValue<T>(async () => value, {
            ttlMs: Number.MAX_SAFE_INTEGER,
            isValid: () => true,
            ...options,
        });
    }
}
