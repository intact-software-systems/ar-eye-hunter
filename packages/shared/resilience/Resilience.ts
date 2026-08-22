import { PartitionRange } from './PartitionRange.ts';

export class AtomicLong {
    private v: number;

    constructor(initial: number) {
        this.v = initial;
    }

    get(): number {
        return this.v;
    }

    set(next: number): void {
        this.v = next;
    }

    addAndGet(delta: number): number {
        this.v += delta;
        return this.v;
    }

    getAndSet(next: number): number {
        const prev = this.v;
        this.v = next;
        return prev;
    }
}

export class AtomicReference<T> {
    private v: T;

    constructor(initial: T) {
        this.v = initial;
    }

    get(): T {
        return this.v;
    }

    set(next: T): void {
        this.v = next;
    }

    getAndSet(next: T): T {
        const prev = this.v;
        this.v = next;
        return prev;
    }

    updateAndGet(fn: (prev: T) => T): T {
        const next = fn(this.v);
        this.v = next;
        return next;
    }
}

function requireNonNull<T>(v: T | null | undefined): T {
    if (v === null || v === undefined) {
        throw new Error('Value was null/undefined');
    }
    return v;
}

function nowMs(): number {
    return Date.now();
}

export class SWBucket {
    public readonly from: number;
    public readonly to: number;

    constructor(
        from: number,
        to: number
    ) {
        this.from = from;
        this.to = to;
    }

    isInBucket(val: number): boolean {
        return this.from <= val && this.to >= val;
    }
}

export class SWStatus {
    public readonly counter: AtomicLong;
    public readonly createdTs: number;

    constructor(
        counter: AtomicLong,
        createdTs: number
    ) {
        this.counter = counter;
        this.createdTs = createdTs;
    }
}

export class SlidingWindowCounter {
    public readonly windowMs: number;
    public readonly bucketMs: number;
    public readonly counterByBucket: Map<SWBucket, SWStatus>;
    public readonly createdTs: number;

    constructor(
        windowMs: number,
        bucketMs: number,
        counterByBucket: Map<SWBucket, SWStatus>,
        createdTs: number
    ) {
        this.windowMs = windowMs;
        this.bucketMs = bucketMs;
        this.counterByBucket = counterByBucket;
        this.createdTs = createdTs;
    }

    static init(windowMs: number, bucketMs: number): SlidingWindowCounter {
        return SlidingWindowCounter.initWithTs(windowMs, bucketMs, nowMs());
    }

    static initWithTs(windowMs: number, bucketMs: number, createdTs: number): SlidingWindowCounter {
        return new SlidingWindowCounter(
            windowMs,
            bucketMs,
            SlidingWindowCounter.initialiseBuckets(windowMs, bucketMs, createdTs),
            createdTs
        );
    }

    update(count: number): SlidingWindowCounter {
        return SlidingWindowCounter.update(this, count);
    }

    static update(windowCounter: SlidingWindowCounter, count: number): SlidingWindowCounter {
        return SlidingWindowCounter.updateWithNow(windowCounter, count, nowMs());
    }

    static updateWithNow(windowCounter: SlidingWindowCounter, count: number, now: number): SlidingWindowCounter {
        const bucketAbsoluteValue = (now - windowCounter.createdTs) % windowCounter.windowMs;

        // Find the first bucket that matches
        let matchBucket: SWBucket | undefined;
        for (const bucket of windowCounter.counterByBucket.keys()) {
            if (bucket.isInBucket(bucketAbsoluteValue)) {
                matchBucket = bucket;
                break;
            }
        }
        if (matchBucket === undefined) {
            throw new Error('No bucket found');
        }

        const existingStatus = requireNonNull(windowCounter.counterByBucket.get(matchBucket));

        if (SlidingWindowCounter.isValidForUpdate(matchBucket, existingStatus, now)) {
            existingStatus.counter.addAndGet(count);
            windowCounter.counterByBucket.set(matchBucket, existingStatus);
        }
        else {
            // Outdated bucket found -> create new
            windowCounter.counterByBucket.set(
                matchBucket,
                new SWStatus(new AtomicLong(count), now)
            );
        }

        return windowCounter;
    }

    sumInWindow(): number {
        return SlidingWindowCounter.sumInWindowWithNow(this, nowMs());
    }

    static sumInWindow(windowCounter: SlidingWindowCounter): number {
        return SlidingWindowCounter.sumInWindowWithNow(windowCounter, nowMs());
    }

    static sumInWindowWithNow(windowCounter: SlidingWindowCounter, now: number): number {
        let sum = 0;

        for (const [bucket, status] of windowCounter.counterByBucket.entries()) {
            if (SlidingWindowCounter.isValidForRead(windowCounter.windowMs, bucket, status, now)) {
                sum += status.counter.get();
            }
        }

        return sum;
    }

    reset(): SlidingWindowCounter {
        return SlidingWindowCounter.reset(this);
    }

    static reset(windowCounter: SlidingWindowCounter): SlidingWindowCounter {
        return SlidingWindowCounter.resetWithNow(windowCounter, nowMs());
    }

    static resetWithNow(
        windowCounter: SlidingWindowCounter,
        createdTs: number
    ): SlidingWindowCounter {
        for (const bucket of windowCounter.counterByBucket.keys()) {
            windowCounter.counterByBucket.set(
                bucket,
                new SWStatus(new AtomicLong(0), createdTs)
            );
        }

        return windowCounter;
    }

    // True if now is in range of bucket duration
    static isValidForUpdate(
        bucket: InstanceType<typeof SWBucket>,
        status: InstanceType<typeof SWStatus>,
        now: number
    ): boolean {
        const bucketDuration = bucket.to - bucket.from;

        // Status valid time: [startTs, ... now .... , endTs]
        const startTs = status.createdTs;
        const endTs = startTs + bucketDuration;

        return now >= startTs && now <= endTs;
    }

    // True if bucket overlaps window, back in time, from now
    static isValidForRead(
        windowMs: number,
        bucket: InstanceType<typeof SWBucket>,
        status: InstanceType<typeof SWStatus>,
        now: number
    ): boolean {
        return SlidingWindowCounter.isOverlap(
            // A: Sliding window range [now - windowMs, now]
            now - windowMs,
            now,
            // B: Bucket window range: [status.createdTs, status.createdTs + (bucket.to - bucket.from)]
            status.createdTs,
            status.createdTs + (bucket.to - bucket.from)
        );
    }

    static isOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
        return Math.max(a1, b1) <= Math.min(a2, b2);
    }

    static initialiseBuckets(
        windowMs: number,
        bucketMs: number,
        createdTs: number
    ): Map<InstanceType<typeof SWBucket>, InstanceType<typeof SWStatus>> {
        const buckets = PartitionRange.partition(
            new SWBucket(0, windowMs),
            0,
            windowMs,
            bucketMs,
            (from, to) => new SWBucket(from, to)
        );

        // Java collector throws on duplicates; we guard by value
        const seen = new Set<string>();
        const map = new Map<InstanceType<typeof SWBucket>, InstanceType<typeof SWStatus>>();

        for (const bucket of buckets) {
            const key = `${bucket.from}-${bucket.to}`;
            if (seen.has(key)) {
                throw new Error('No duplicate buckets allowed');
            }
            seen.add(key);

            map.set(bucket, new SWStatus(new AtomicLong(0), createdTs));
        }

        return map;
    }
}

export class RateAdjusterStatus {
    public readonly rate: number;
    public readonly currentNumSuccesses: number;

    constructor(
        rate: number,
        currentNumSuccesses: number
    ) {
        this.rate = rate;
        this.currentNumSuccesses = currentNumSuccesses;
    }
}

export class RateAdjusterPolicy {
    public readonly initialRate: number;
    public readonly maxRate: number;
    public readonly concurrencyIncreaseStep: number;
    public readonly concurrencyReduceStep: number;
    public readonly minConsecutiveSuccesses: number;
    public readonly adjustWindowMs: number;

    constructor(
        initialRate: number,
        maxRate: number,
        concurrencyIncreaseStep: number,
        concurrencyReduceStep: number,
        minConsecutiveSuccesses: number,
        adjustWindowMs: number
    ) {
        this.initialRate = initialRate;
        this.maxRate = maxRate;
        this.concurrencyIncreaseStep = concurrencyIncreaseStep;
        this.concurrencyReduceStep = concurrencyReduceStep;
        this.minConsecutiveSuccesses = minConsecutiveSuccesses;
        this.adjustWindowMs = adjustWindowMs;
    }
}

export class RateAdjuster {
    public readonly status: AtomicReference<RateAdjusterStatus>;
    public readonly slidingWindow: SlidingWindowCounter;
    public readonly policy: RateAdjusterPolicy;

    constructor(
        status: AtomicReference<RateAdjusterStatus>,
        slidingWindow: SlidingWindowCounter,
        policy: RateAdjusterPolicy
    ) {
        this.status = status;
        this.slidingWindow = slidingWindow;
        this.policy = policy;
    }

    static toPolicy(
        initialRate: number,
        maxRate: number,
        concurrencyIncreaseStep: number,
        concurrencyReduceStep: number,
        minConsecutiveSuccesses: number,
        adjustWindowMs: number
    ): RateAdjusterPolicy {
        return new RateAdjusterPolicy(
            Math.max(1, Math.min(initialRate, maxRate)),
            Math.max(1, Math.max(initialRate, maxRate)),
            Math.max(1, Math.min(maxRate, concurrencyIncreaseStep)),
            Math.max(1, Math.min(maxRate, concurrencyReduceStep)),
            minConsecutiveSuccesses,
            adjustWindowMs
        );
    }

    static create(policy: RateAdjusterPolicy): RateAdjuster {
        return RateAdjuster.createWithTs(policy, nowMs());
    }

    static createWithTs(policy: RateAdjusterPolicy, createdTs: number): RateAdjuster {
        return new RateAdjuster(
            new AtomicReference(new RateAdjusterStatus(policy.initialRate, 0)),
            SlidingWindowCounter.initWithTs(
                policy.adjustWindowMs,
                Math.floor(policy.adjustWindowMs / 4),
                createdTs
            ),
            policy
        );
    }

    success(): RateAdjuster {
        return this.successAt(nowMs());
    }

    successAt(nowEpochMs: number): RateAdjuster {
        SlidingWindowCounter.updateWithNow(this.slidingWindow, 1, nowEpochMs);
        return this;
    }

    failure(): RateAdjuster {
        return this.failureAt(nowMs());
    }

    failureAt(nowEpochMs: number): RateAdjuster {
        SlidingWindowCounter.resetWithNow(this.slidingWindow, nowEpochMs);

        this.status.updateAndGet((existingStatus) => {
            return new RateAdjusterStatus(
                Math.max(this.policy.initialRate, existingStatus.rate - this.policy.concurrencyReduceStep),
                0
            );
        });

        return this;
    }

    // NB! calculates and mutates
    calculateRate(): number {
        return this.calculateRateAt(nowMs());
    }

    calculateRateAt(nowEpochMs: number): number {
        const numSuccesses = SlidingWindowCounter.sumInWindowWithNow(
            this.slidingWindow,
            nowEpochMs
        );
        const existingStatus = this.status.get();

        if ((numSuccesses - existingStatus.currentNumSuccesses) >= this.policy.minConsecutiveSuccesses) {
            // new rate to apply
            const newStatus = new RateAdjusterStatus(
                Math.min(this.policy.maxRate, existingStatus.rate + this.policy.concurrencyIncreaseStep),
                numSuccesses
            );

            this.status.set(newStatus);
            return newStatus.rate;
        }

        return existingStatus.rate;
    }
}

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
        return RateLimiter.initWithTs(timebasedFilterMs, maxNumberToAllow, nowMs());
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
        return this.allowAt(nowMs());
    }

    allowAt(nowEpochMs: number): boolean {
        if (
            SlidingWindowCounter.sumInWindowWithNow(this.slidingWindow, nowEpochMs) >=
                this.policy.maxNumberToAllow
        ) {
            return false;
        }

        SlidingWindowCounter.updateWithNow(this.slidingWindow, 1, nowEpochMs);
        return true;
    }

    isAllowed(): boolean {
        return this.slidingWindow.sumInWindow() < this.policy.maxNumberToAllow;
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
