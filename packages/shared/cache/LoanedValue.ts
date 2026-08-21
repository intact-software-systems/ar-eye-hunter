import { ReadableValue } from './ReadableValue.ts';

export type LoanedValueRefresh<T> = (
    current: T | undefined
) => T | Promise<T>;

export type LoanedValueValidityChecker<T> = (value: T, nowEpochMs: number) => boolean;

export interface LoanedValueOptions<T> {
    ttlMs?: number;
    isValid?: LoanedValueValidityChecker<T>;
}

const NEVER_EXPIRES_MS = Number.MAX_SAFE_INTEGER;

export class LoanedValue<T> implements ReadableValue<T> {
    private readonly ttlMs: number;
    private readonly isValid: LoanedValueValidityChecker<T>;

    private value: T | undefined;
    private valueStartMs = 0;
    private holdsValue = false;
    private inFlightRefresh: Promise<T> | undefined;

    private readonly refresher: LoanedValueRefresh<T>;

    public constructor(
        refresher: LoanedValueRefresh<T>,
        options: LoanedValueOptions<T> = {}
    ) {
        this.refresher = refresher;
        if (!refresher) {
            throw new Error('refresher is required');
        }

        this.ttlMs = options.ttlMs ?? NEVER_EXPIRES_MS;
        this.isValid = options.isValid ?? (() => true);

        if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0) {
            throw new Error('ttlMs must be a finite non-negative number');
        }
    }

    public acceptAt(value: T, nowEpochMs: number): void {
        this.value = value;
        this.valueStartMs = nowEpochMs;
        this.holdsValue = true;
        this.inFlightRefresh = undefined;
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

    public async get(): Promise<T> {
        if (!this.isExpired(this.value)) {
            return this.value as T;
        }

        return this.runRefresh(true, this.refresher);
    }

    public async getWith(refresher: LoanedValueRefresh<T>): Promise<T> {
        if (!this.isExpired(this.value)) {
            return this.value as T;
        }

        return this.runRefresh(true, refresher);
    }

    public async refresh(): Promise<T> {
        return this.runRefresh(false, this.refresher);
    }

    public async refreshWith(refresher: LoanedValueRefresh<T>): Promise<T> {
        return this.runRefresh(false, refresher);
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

    public clear(): void {
        this.value = undefined;
        this.valueStartMs = 0;
        this.holdsValue = false;
    }

    public refreshing(): boolean {
        return this.inFlightRefresh !== undefined;
    }

    private async runRefresh(
        onlyIfStillExpired: boolean,
        refresher: LoanedValueRefresh<T>
    ): Promise<T> {
        if (this.inFlightRefresh) {
            return this.inFlightRefresh;
        }

        this.inFlightRefresh = (async () => {
            try {
                if (onlyIfStillExpired && !this.isExpired(this.value)) {
                    return this.value as T;
                }

                const next = await refresher(this.value);

                if (next === undefined || next === null) {
                    throw new Error('Refresher returned null or undefined');
                }

                this.value = next;
                this.valueStartMs = Date.now();
                return next;
            }
            finally {
                this.inFlightRefresh = undefined;
            }
        })();

        return this.inFlightRefresh;
    }

    private isExpired(value: T | undefined): boolean {
        return this.isExpiredAt(value, Date.now());
    }

    private isExpiredAt(value: T | undefined, nowEpochMs: number): boolean {
        if (value === undefined) {
            return true;
        }

        if (!this.holdsValue && this.valueStartMs === 0) {
            return true;
        }

        if (nowEpochMs - this.valueStartMs > this.ttlMs) {
            return true;
        }

        return !this.isValid(value, nowEpochMs);
    }
}
