import { ReadableValue } from './ReadableValue.ts';

export type ValueValidityChecker<T> = (value: T, nowEpochMs: number) => boolean;

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
    private expireAtEpochMs: number | undefined;
    private holdsValue = false;

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
        this.expireAtEpochMs = undefined;
        this.holdsValue = false;
    }

    public acceptAt(value: T, nowEpochMs: number, expireAtEpochMs?: number): void {
        this.value = value;
        this.valueStartMs = nowEpochMs;
        this.expireAtEpochMs = expireAtEpochMs;
        this.holdsValue = true;
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
        return this.readAt(Date.now());
    }

    public readAt(nowEpochMs: number): T | undefined {
        return this.isExpiredAt(this.value, nowEpochMs) ? undefined : this.value;
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

        this.acceptAt(update, Date.now());
        return true;
    }

    public getAndSet(update: T): T | undefined {
        const previous = this.value;
        this.acceptAt(update, Date.now());
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
        return this.takeIfExpiredAt(Date.now());
    }

    public takeIfExpiredAt(nowEpochMs: number): T | undefined {
        if (!this.isExpiredAt(this.value, nowEpochMs)) {
            return undefined;
        }

        return this.take();
    }

    public hasValue(): boolean {
        return this.value !== undefined;
    }

    public expired(): boolean {
        return this.expiredAt(Date.now());
    }

    public expiredAt(nowEpochMs: number): boolean {
        return this.isExpiredAt(this.value, nowEpochMs);
    }

    public refreshing(): boolean {
        return false;
    }

    public clear(): void {
        this.value = undefined;
        this.valueStartMs = 0;
        this.expireAtEpochMs = undefined;
        this.holdsValue = false;
    }

    private isExpiredAt(value: T | undefined, nowEpochMs: number): boolean {
        if (value === undefined) {
            return true;
        }

        if (!this.holdsValue && this.valueStartMs === 0) {
            return true;
        }

        if (this.expireAtEpochMs !== undefined && nowEpochMs >= this.expireAtEpochMs) {
            return true;
        }

        if (nowEpochMs - this.valueStartMs > this.ttlMs) {
            return true;
        }

        return !this.isValid(value, nowEpochMs);
    }
}
