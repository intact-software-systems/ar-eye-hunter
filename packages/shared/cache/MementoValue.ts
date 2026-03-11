export interface MementoOptions {
    undoDepth?: number;
    redoDepth?: number;
}

export interface MementoSnapshot<T> {
    value: T | undefined;
    undos: T[];
    redos: T[];
    undoDepth: number;
    redoDepth: number;
}

const DEFAULT_UNDO_DEPTH = 10;
const DEFAULT_REDO_DEPTH = 10;

export class MementoValue<T> {
    private value: T | undefined;
    private readonly undos: T[] = [];
    private readonly redos: T[] = [];
    private readonly undoDepth: number;
    private readonly redoDepth: number;

    public constructor(options: MementoOptions = {}) {
        this.undoDepth = options.undoDepth ?? DEFAULT_UNDO_DEPTH;
        this.redoDepth = options.redoDepth ?? DEFAULT_REDO_DEPTH;

        if (!Number.isInteger(this.undoDepth) || this.undoDepth < 0) {
            throw new Error('undoDepth must be an integer >= 0');
        }

        if (!Number.isInteger(this.redoDepth) || this.redoDepth < 0) {
            throw new Error('redoDepth must be an integer >= 0');
        }
    }

    public static fromSnapshot<T>(snapshot: MementoSnapshot<T>): MementoValue<T> {
        const memento = new MementoValue<T>({
            undoDepth: snapshot.undoDepth,
            redoDepth: snapshot.redoDepth,
        });

        memento.value = snapshot.value;
        memento.undos.push(...snapshot.undos);
        memento.redos.push(...snapshot.redos);

        return memento;
    }

    public copy(): MementoValue<T> {
        return MementoValue.fromSnapshot(this.snapshot());
    }

    public snapshot(): MementoSnapshot<T> {
        return {
            value: this.value,
            undos: [...this.undos],
            redos: [...this.redos],
            undoDepth: this.undoDepth,
            redoDepth: this.redoDepth,
        };
    }

    /**
     * Java-like name.
     */
    public get(): T | undefined {
        return this.value;
    }

    /**
     * Alias for get().
     */
    public read(): T | undefined {
        return this.value;
    }

    /**
     * More UI/editor-friendly name.
     */
    public present(): T | undefined {
        return this.value;
    }

    /**
     * Java-like name.
     */
    public set(newValue: T | undefined): this {
        this.pushUndo(this.value);
        this.value = newValue;
        this.redos.length = 0;
        return this;
    }

    /**
     * More UI/editor-friendly name.
     */
    public commit(newValue: T | undefined): this {
        return this.set(newValue);
    }

    public compareAndSet(expect: T | undefined, update: T | undefined): boolean {
        if (!Object.is(this.value, expect)) {
            return false;
        }

        this.pushUndo(this.value);
        this.value = update;
        this.redos.length = 0;
        return true;
    }

    public getAndSet(newValue: T | undefined): T | undefined {
        const previous = this.value;
        this.pushUndo(previous);
        this.value = newValue;
        this.redos.length = 0;
        return previous;
    }

    /**
     * Newest first.
     */
    public undoStack(): readonly T[] {
        return [...this.undos];
    }

    /**
     * Newest first.
     */
    public redoStack(): readonly T[] {
        return [...this.redos];
    }

    public canUndo(): boolean {
        return this.undos.length > 0;
    }

    public canRedo(): boolean {
        return this.redos.length > 0;
    }

    public undo(): T | undefined {
        const nextCurrent = this.undos.shift();
        if (nextCurrent === undefined) {
            return undefined;
        }

        this.pushRedo(this.value);
        this.value = nextCurrent;
        return this.value;
    }

    public redo(): T | undefined {
        const nextCurrent = this.redos.shift();
        if (nextCurrent === undefined) {
            return undefined;
        }

        this.pushUndo(this.value);
        this.value = nextCurrent;
        return this.value;
    }

    public clearRedo(): this {
        this.redos.length = 0;
        return this;
    }

    public clearUndo(): this {
        this.undos.length = 0;
        return this;
    }

    public clearAll(): this {
        this.value = undefined;
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
            this.value === undefined &&
            this.undos.length === 0 &&
            this.redos.length === 0
        );
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

    private trimToDepth(stack: T[], depth: number): void {
        if (stack.length > depth) {
            stack.length = depth;
        }
    }
}