import { SlidingWindowCounter } from './sliding-window-counter.ts';

export class RateLimiterPolicy {
    public readonly timebasedFilterMs: number;
    public readonly maxNumberToAllow: number;

    constructor(
        timebasedFilterMs: number,
        maxNumberToAllow: number
    ) {
        this.timebasedFilterMs = timebasedFilterMs;
        this.maxNumberToAllow = maxNumberToAllow;
    }
}

export class RateLimiter {
    public readonly slidingWindow: SlidingWindowCounter;
    public readonly policy: RateLimiterPolicy;

    constructor(
        slidingWindow: SlidingWindowCounter,
        policy: RateLimiterPolicy
    ) {
        this.slidingWindow = slidingWindow;
        this.policy = policy;
    }

    static init(timebasedFilterMs: number, maxNumberToAllow: number): RateLimiter {
        return RateLimiter.initWithTs(timebasedFilterMs, maxNumberToAllow, Date.now());
    }

    static initWithTs(
        timebasedFilterMs: number,
        maxNumberToAllow: number,
        createdTs: number
    ): RateLimiter {
        return new RateLimiter(
            SlidingWindowCounter.initWithTs(
                timebasedFilterMs,
                Math.floor(timebasedFilterMs / 4),
                createdTs
            ),
            new RateLimiterPolicy(timebasedFilterMs, maxNumberToAllow)
        );
    }

    static async tryToExecuteOrDefault<T>(
        rateLimiter: RateLimiter,
        supplier: () => Promise<T>,
        defaultValue: T
    ): Promise<T> {
        if (!rateLimiter.allow()) {
            return defaultValue;
        }
        return await supplier();
    }

    static async tryToExecuteOrElse<T>(
        rateLimiter: RateLimiter,
        supplier: () => Promise<T>,
        orElse: () => Promise<T>
    ): Promise<T> {
        if (!rateLimiter.allow()) {
            return await orElse();
        }

        return await supplier();
    }

    allow(): boolean {
        return this.allowAt(Date.now());
    }

    allowAt(nowEpochMs: number): boolean {
        if (!this.isAllowedAt(nowEpochMs)) {
            return false;
        }

        SlidingWindowCounter.updateWithNow(this.slidingWindow, 1, this.toWindowNowMs(nowEpochMs));
        return true;
    }

    isAllowed(): boolean {
        return this.slidingWindow.sumInWindow() < this.policy.maxNumberToAllow;
    }

    /** Whether `allowAt` would allow at `nowEpochMs`, without spending. */
    isAllowedAt(nowEpochMs: number): boolean {
        return SlidingWindowCounter.sumInWindowWithNow(this.slidingWindow, this.toWindowNowMs(nowEpochMs)) <
            this.policy.maxNumberToAllow;
    }

    /** The window has no bucket before its creation, so a clock that stepped back behind it reads as the creation. */
    private toWindowNowMs(nowEpochMs: number): number {
        return Math.max(nowEpochMs, this.slidingWindow.createdTs);
    }
}

export function toRateLimiter(
    windowDurationMs: number = 1_000,
    maxNumber: number = 20
): RateLimiter {
    return RateLimiter.init(
        windowDurationMs,
        maxNumber
    );
}
