import { ReadableValue } from './ReadableValue.ts';

export type ValueValidityChecker<T> = (value: T) => boolean;

export interface LatestValueOptions<T> {
    ttlMs?: number;
    isValid?: ValueValidityChecker<T>;
}

export interface ValueSink<T> {
    accept(value: T): void;
}

const NEVER_EXPIRES_MS = Number.MAX_SAFE_INTEGER;

export class LatestValue<T> implements ReadableValue<T>, ValueSink<T> {
    private readonly ttlMs: number;
    private readonly isValid: ValueValidityChecker<T>;

    private value: T | undefined;
    private valueStartMs = 0;

    public constructor(options: LatestValueOptions<T> = {}) {
        this.ttlMs = options.ttlMs ?? NEVER_EXPIRES_MS;
        this.isValid = options.isValid ?? (() => true);

        if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0) {
            throw new Error('ttlMs must be a finite non-negative number');
        }
    }

    public accept(value: T): void {
        this.value = value;
        this.valueStartMs = Date.now();
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

    public read(): T | undefined {
        return this.isExpired(this.value) ? undefined : this.value;
    }

    public peek(): T | undefined {
        return this.value;
    }

    public get(): T {
        const value = this.read();
        if (value === undefined) {
            throw new Error('No latest value available');
        }
        return value;
    }

    public getOrElse(fallback: T): T {
        return this.read() ?? fallback;
    }

    public getOrElseGet(factory: () => T): T {
        const value = this.read();
        return value !== undefined ? value : factory();
    }

    public compareAndSet(expect: T | undefined, update: T): boolean {
        if (!Object.is(this.value, expect)) {
            return false;
        }

        this.value = update;
        this.valueStartMs = Date.now();
        return true;
    }

    public getAndSet(update: T): T | undefined {
        const previous = this.value;
        this.value = update;
        this.valueStartMs = Date.now();
        return previous;
    }

    public touch(): boolean {
        if (this.value === undefined) {
            return false;
        }

        this.valueStartMs = Date.now();
        return true;
    }

    public take(): T | undefined {
        const current = this.value;
        this.clear();
        return current;
    }

    public takeIfExpired(): T | undefined {
        if (!this.isExpired(this.value)) {
            return undefined;
        }

        return this.take();
    }

    public hasValue(): boolean {
        return this.value !== undefined;
    }

    public expired(): boolean {
        return this.isExpired(this.value);
    }

    public refreshing(): boolean {
        return false;
    }

    public clear(): void {
        this.value = undefined;
        this.valueStartMs = 0;
    }

    private isExpired(value: T | undefined): boolean {
        if (value === undefined) {
            return true;
        }

        if (this.valueStartMs === 0) {
            return true;
        }

        if (Date.now() - this.valueStartMs > this.ttlMs) {
            return true;
        }

        return !this.isValid(value);
    }
}