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
    public readonly policy: RateLimiterPolicy;
    /** Tokens scaled by `timebasedFilterMs`, so integer instants refill without rounding drift. */
    private scaledTokens: number;
    private refilledAtMs: number;

    constructor(policy: RateLimiterPolicy, createdTs: number) {
        this.policy = policy;
        this.scaledTokens = this.toScaledCapacity();
        this.refilledAtMs = createdTs;
    }

    static init(timebasedFilterMs: number, maxNumberToAllow: number): RateLimiter {
        return RateLimiter.initWithTs(timebasedFilterMs, maxNumberToAllow, Date.now());
    }

    static initWithTs(
        timebasedFilterMs: number,
        maxNumberToAllow: number,
        createdTs: number
    ): RateLimiter {
        return new RateLimiter(new RateLimiterPolicy(timebasedFilterMs, maxNumberToAllow), createdTs);
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
        this.scaledTokens = this.computeScaledTokensAt(nowEpochMs);
        this.refilledAtMs = Math.max(nowEpochMs, this.refilledAtMs);
        if (this.scaledTokens < this.policy.timebasedFilterMs) {
            return false;
        }

        this.scaledTokens -= this.policy.timebasedFilterMs;
        return true;
    }

    isAllowed(): boolean {
        return this.isAllowedAt(Date.now());
    }

    /** Whether `allowAt` would allow at `nowEpochMs`, without spending. */
    isAllowedAt(nowEpochMs: number): boolean {
        return this.computeScaledTokensAt(nowEpochMs) >= this.policy.timebasedFilterMs;
    }

    /** A clock that stepped back behind the last refill reads as that refill, so it neither refills nor throws. */
    private computeScaledTokensAt(nowEpochMs: number): number {
        const elapsedMs = Math.max(nowEpochMs, this.refilledAtMs) - this.refilledAtMs;
        return Math.min(this.toScaledCapacity(), this.scaledTokens + elapsedMs * this.policy.maxNumberToAllow);
    }

    private toScaledCapacity(): number {
        return this.policy.maxNumberToAllow * this.policy.timebasedFilterMs;
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
