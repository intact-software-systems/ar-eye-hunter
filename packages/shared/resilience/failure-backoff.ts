import { toExponentialBackoffMs } from './ComputeAsyncTask.ts';

export namespace FailureBackoff {
    export interface Config {
        readonly baseMs: number;
        readonly maxMs: number;
    }
}

/** Consecutive failures wait the base, then double it up to the cap; a success starts the schedule over. */
export class FailureBackoff {
    private readonly config: FailureBackoff.Config;
    private consecutiveFailures = 0;
    private retryAtMs: number | undefined;

    constructor(config: FailureBackoff.Config) {
        if (!isPositiveFinite(config.baseMs) || !isPositiveFinite(config.maxMs)) {
            throw new TypeError('Failure backoff requires a positive finite base and maximum delay');
        }
        this.config = config;
    }

    /** Answers the instant the next attempt may run. */
    recordFailure(nowMs: number): number {
        this.consecutiveFailures += 1;
        this.retryAtMs = nowMs +
            toExponentialBackoffMs(this.consecutiveFailures, this.config.maxMs, this.config.baseMs);
        return this.retryAtMs;
    }

    recordSuccess(): void {
        this.consecutiveFailures = 0;
        this.retryAtMs = undefined;
    }

    /** The retry instant while it still lies ahead of `nowMs`; `undefined` once an attempt may run. */
    getRetryAtMs(nowMs: number): number | undefined {
        return this.retryAtMs !== undefined && this.retryAtMs > nowMs ? this.retryAtMs : undefined;
    }

    getConsecutiveFailures(): number {
        return this.consecutiveFailures;
    }
}

function isPositiveFinite(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}
