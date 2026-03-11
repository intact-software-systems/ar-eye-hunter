import { ReadableValue } from './ReadableValue.ts';

export type LoanedValueRefresh<T> = (
    current: T | undefined,
) => T | Promise<T>;

export type LoanedValueValidityChecker<T> = (value: T) => boolean;

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
    private inFlightRefresh: Promise<T> | undefined;

    public constructor(
        private readonly refresher: LoanedValueRefresh<T>,
        options: LoanedValueOptions<T> = {},
    ) {
        if (!refresher) {
            throw new Error('refresher is required');
        }

        this.ttlMs = options.ttlMs ?? NEVER_EXPIRES_MS;
        this.isValid = options.isValid ?? (() => true);

        if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0) {
            throw new Error('ttlMs must be a finite non-negative number');
        }
    }

    public read(): T | undefined {
        return this.isExpired(this.value) ? undefined : this.value;
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

    public clear(): void {
        this.value = undefined;
        this.valueStartMs = 0;
    }

    public refreshing(): boolean {
        return this.inFlightRefresh !== undefined;
    }

    private async runRefresh(
        onlyIfStillExpired: boolean,
        refresher: LoanedValueRefresh<T>,
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
            } finally {
                this.inFlightRefresh = undefined;
            }
        })();

        return this.inFlightRefresh;
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
