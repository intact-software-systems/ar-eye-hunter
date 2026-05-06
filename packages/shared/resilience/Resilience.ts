import { Either } from './Either.ts';
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
    constructor(
        public readonly from: number,
        public readonly to: number,
    ) {
    }

    isInBucket(val: number): boolean {
        return this.from <= val && this.to >= val;
    }
}

export class SWStatus {
    constructor(
        public readonly counter: AtomicLong,
        public readonly createdTs: number,
    ) {
    }
}

export class SlidingWindowCounter {
    constructor(
        public readonly windowMs: number,
        public readonly bucketMs: number,
        public readonly counterByBucket: Map<SWBucket, SWStatus>,
        public readonly createdTs: number,
    ) {
    }

    static init(windowMs: number, bucketMs: number): SlidingWindowCounter {
        return SlidingWindowCounter.initWithTs(windowMs, bucketMs, nowMs());
    }

    static initWithTs(windowMs: number, bucketMs: number, createdTs: number): SlidingWindowCounter {
        return new SlidingWindowCounter(
            windowMs,
            bucketMs,
            SlidingWindowCounter.initialiseBuckets(windowMs, bucketMs, createdTs),
            createdTs,
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
        } else {
            // Outdated bucket found -> create new
            windowCounter.counterByBucket.set(
                matchBucket,
                new SWStatus(new AtomicLong(count), now),
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
        const createdTs = nowMs();

        for (const bucket of windowCounter.counterByBucket.keys()) {
            windowCounter.counterByBucket.set(
                bucket,
                new SWStatus(new AtomicLong(0), createdTs),
            );
        }

        return windowCounter;
    }

    // True if now is in range of bucket duration
    static isValidForUpdate(
        bucket: InstanceType<typeof SWBucket>,
        status: InstanceType<typeof SWStatus>,
        now: number,
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
        now: number,
    ): boolean {
        return SlidingWindowCounter.isOverlap(
            // A: Sliding window range [now - windowMs, now]
            now - windowMs,
            now,
            // B: Bucket window range: [status.createdTs, status.createdTs + (bucket.to - bucket.from)]
            status.createdTs,
            status.createdTs + (bucket.to - bucket.from),
        );
    }

    static isOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
        return Math.max(a1, b1) <= Math.min(a2, b2);
    }

    static initialiseBuckets(
        windowMs: number,
        bucketMs: number,
        createdTs: number,
    ): Map<InstanceType<typeof SWBucket>, InstanceType<typeof SWStatus>> {
        const buckets = PartitionRange.partition(
            new SWBucket(0, windowMs),
            0,
            windowMs,
            bucketMs,
            (from, to) => new SWBucket(from, to),
        );

        // Java collector throws on duplicates; we guard by value
        const seen = new Set<string>();
        const map = new Map<
            InstanceType<typeof SWBucket>,
            InstanceType<typeof SWStatus>
        >();

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

export enum CircuitBreakerState {
    OPEN = 'OPEN',
    CLOSE = 'CLOSE',
    HALF_OPEN = 'HALF_OPEN',
}

export class CircuitBreakerPolicy {
    constructor(
        public readonly maxConsecutiveFailures: number,
        public readonly resetTimeout: Temporal.Duration,
        public readonly halfOpenTimeout: Temporal.Duration,
        public readonly slidingWindow: Temporal.Duration,
    ) {
    }
}

export class CircuitBreaker {
    private static readonly RESET_VALUE = Number.MAX_SAFE_INTEGER;

    constructor(
        public readonly state: AtomicReference<CircuitBreakerState>,
        public readonly slidingWindow: SlidingWindowCounter,
        public readonly timestampOpen: AtomicLong,
        public readonly timestampHalfOpen: AtomicLong,
        public readonly policy: CircuitBreakerPolicy,
    ) {
    }

    static create(policy: CircuitBreakerPolicy): CircuitBreaker {
        return new CircuitBreaker(
            new AtomicReference<CircuitBreakerState>(CircuitBreakerState.CLOSE),
            SlidingWindowCounter.init(
                policy.slidingWindow.total({ unit: 'milliseconds' }),
                Math.floor(policy.slidingWindow.total({ unit: 'milliseconds' }) / 10),
            ),
            new AtomicLong(CircuitBreaker.RESET_VALUE),
            new AtomicLong(CircuitBreaker.RESET_VALUE),
            policy,
        );
    }

    static async tryToExecute<T>(
        circuitBreaker: CircuitBreaker,
        supplier: () => Promise<T>,
    ): Promise<Either<Error, T>> {
        try {
            if (!circuitBreaker.allow()) {
                return Either.ofLeft(new Error('Not allowed to execute'));
            }

            const value = await supplier();
            circuitBreaker.success();

            return Either.ofRight(value);
        } catch (e) {
            circuitBreaker.failure();
            return Either.ofLeft(e instanceof Error ? e : new Error(String(e)));
        }
    }

    static async tryToExecuteBooleanSupplier(
        circuitBreaker: CircuitBreaker,
        supplier: () => Promise<boolean>
    ): Promise<boolean> {
        try {
            if (!circuitBreaker.allow()) {
                return false;
            }

            const isSuccess = await supplier();

            if (isSuccess) {
                circuitBreaker.success();
            } else {
                circuitBreaker.failure();
            }

            return isSuccess;
        } catch (error) {
            circuitBreaker.failure();
            console.error('Execution failed:', error);
            return false;
        }
    }

    success(): CircuitBreaker {
        this.slidingWindow.reset();

        this.timestampOpen.set(CircuitBreaker.RESET_VALUE);
        this.timestampHalfOpen.set(CircuitBreaker.RESET_VALUE);
        this.state.set(CircuitBreakerState.CLOSE);

        return this;
    }

    failure(): CircuitBreaker {
        return this.failureCount(1);
    }

    failureCount(count: number): CircuitBreaker {
        this.slidingWindow.update(count);

        const sumInWindow = this.slidingWindow.sumInWindow();
        if (
            // if sum of failures in window > maximum allowed failures in window, then trip circuit OPEN
            sumInWindow > this.policy.maxConsecutiveFailures ||
            // the breaker is tripped again into the OPEN state for another full resetTimeout
            this.state.get() === CircuitBreakerState.HALF_OPEN
        ) {
            const previous = this.state.getAndSet(CircuitBreakerState.OPEN);
            if (previous !== CircuitBreakerState.OPEN) {
                // this thread set new state
                this.timestampOpen.set(nowMs());
                this.timestampHalfOpen.set(CircuitBreaker.RESET_VALUE);
            }
        }

        return this;
    }

    // Mutating update of circuit breaker
    allow(): boolean {
        if (this.state.get() === CircuitBreakerState.OPEN) {
            const timeSinceOpened = nowMs() - this.timestampOpen.get();

            if (timeSinceOpened > this.policy.resetTimeout.total({ unit: 'milliseconds' })) {
                const previous = this.state.getAndSet(CircuitBreakerState.HALF_OPEN);
                if (previous === CircuitBreakerState.OPEN) {
                    // This thread set circuit to half open and is allowed through
                    this.timestampHalfOpen.set(nowMs());
                    return true;
                }
            }
        } else if (this.state.get() === CircuitBreakerState.HALF_OPEN) {
            // check if state has been in half open too long
            const timeSinceHalfOpened = nowMs() - this.timestampHalfOpen.get();

            if (timeSinceHalfOpened > this.policy.halfOpenTimeout.total({ unit: 'milliseconds' })) {
                this.failureCount(1);
            }
        }

        return this.state.get() === CircuitBreakerState.CLOSE;
    }

    // Note: Non-mutating check of circuit breaker
    isAllowedThrough(): boolean {
        if (this.state.get() === CircuitBreakerState.OPEN) {
            const timeSinceOpened = nowMs() - this.timestampOpen.get();
            if (timeSinceOpened > this.policy.resetTimeout.total({ unit: 'milliseconds' })) {
                return true;
            }
        } else if (this.state.get() === CircuitBreakerState.HALF_OPEN) {
            const timeSinceHalfOpened = nowMs() - this.timestampHalfOpen.get();
            if (timeSinceHalfOpened > this.policy.halfOpenTimeout.total({ unit: 'milliseconds' })) {
                return true;
            }
        }

        return this.state.get() === CircuitBreakerState.CLOSE;
    }

    isOpen(): boolean {
        return this.state.get() === CircuitBreakerState.OPEN;
    }

    isHalfOpen(): boolean {
        return this.state.get() === CircuitBreakerState.HALF_OPEN;
    }

    isClosed(): boolean {
        return this.state.get() === CircuitBreakerState.CLOSE;
    }
}

export class RateAdjusterStatus {
    constructor(
        public readonly rate: number,
        public readonly currentNumSuccesses: number,
    ) {
    }
}

export class RateAdjusterPolicy {
    constructor(
        public readonly initialRate: number,
        public readonly maxRate: number,
        public readonly concurrencyIncreaseStep: number,
        public readonly concurrencyReduceStep: number,
        public readonly minConsecutiveSuccesses: number,
        public readonly adjustWindowMs: number,
    ) {
    }
}

export class RateAdjuster {
    constructor(
        public readonly status: AtomicReference<RateAdjusterStatus>,
        public readonly slidingWindow: SlidingWindowCounter,
        public readonly policy: RateAdjusterPolicy,
    ) {
    }

    static toPolicy(
        initialRate: number,
        maxRate: number,
        concurrencyIncreaseStep: number,
        concurrencyReduceStep: number,
        minConsecutiveSuccesses: number,
        adjustWindowMs: number,
    ): RateAdjusterPolicy {
        return new RateAdjusterPolicy(
            Math.max(1, Math.min(initialRate, maxRate)),
            Math.max(1, Math.max(initialRate, maxRate)),
            Math.max(1, Math.min(maxRate, concurrencyIncreaseStep)),
            Math.max(1, Math.min(maxRate, concurrencyReduceStep)),
            minConsecutiveSuccesses,
            adjustWindowMs,
        );
    }

    static create(policy: RateAdjusterPolicy): RateAdjuster {
        return new RateAdjuster(
            new AtomicReference(new RateAdjusterStatus(policy.initialRate, 0)),
            SlidingWindowCounter.init(
                policy.adjustWindowMs,
                Math.floor(policy.adjustWindowMs / 4),
            ),
            policy,
        );
    }

    success(): RateAdjuster {
        this.slidingWindow.update(1);
        return this;
    }

    failure(): RateAdjuster {
        this.slidingWindow.reset();

        this.status.updateAndGet((existingStatus) => {
            return new RateAdjusterStatus(
                Math.max(this.policy.initialRate, existingStatus.rate - this.policy.concurrencyReduceStep),
                0,
            );
        });

        return this;
    }

    // NB! calculates and mutates
    calculateRate(): number {
        const numSuccesses = this.slidingWindow.sumInWindow();
        const existingStatus = this.status.get();

        if ((numSuccesses - existingStatus.currentNumSuccesses) >= this.policy.minConsecutiveSuccesses) {
            // new rate to apply
            const newStatus = new RateAdjusterStatus(
                Math.min(this.policy.maxRate, existingStatus.rate + this.policy.concurrencyIncreaseStep),
                numSuccesses,
            );

            this.status.set(newStatus);
            return newStatus.rate;
        }

        return existingStatus.rate;
    }
}

export class RateLimiterPolicy {
    constructor(
        public readonly timebasedFilterMs: number,
        public readonly maxNumberToAllow: number,
    ) {
    }
}

export class RateLimiter {
    constructor(
        public readonly slidingWindow: SlidingWindowCounter,
        public readonly policy: RateLimiterPolicy,
    ) {
    }

    static init(timebasedFilterMs: number, maxNumberToAllow: number): RateLimiter {
        return new RateLimiter(
            SlidingWindowCounter.init(
                timebasedFilterMs,
                Math.floor(timebasedFilterMs / 4),
            ),
            new RateLimiterPolicy(timebasedFilterMs, maxNumberToAllow),
        );
    }

    static async tryToExecuteOrDefault<T>(
        rateLimiter: RateLimiter,
        supplier: () => Promise<T>,
        defaultValue: T,
    ): Promise<T> {
        if (!rateLimiter.allow()) {
            return defaultValue;
        }
        return await supplier();
    }

    allow(): boolean {
        if (this.slidingWindow.sumInWindow() >= this.policy.maxNumberToAllow) {
            return false;
        }

        this.slidingWindow.update(1);
        return true;
    }

    isAllowed(): boolean {
        return this.slidingWindow.sumInWindow() < this.policy.maxNumberToAllow;
    }
}
