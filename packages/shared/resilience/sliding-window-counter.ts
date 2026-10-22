import { AtomicLong } from './atomic-long.ts';
import { PartitionRange } from './PartitionRange.ts';

function requireNonNull<T>(v: T | null | undefined): T {
    if (v === null || v === undefined) {
        throw new Error('Value was null/undefined');
    }
    return v;
}

function nowMs(): number {
    return Date.now();
}

export class SlidingWindowBucket {
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

export class SlidingWindowStatus {
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
    public readonly counterByBucket: Map<SlidingWindowBucket, SlidingWindowStatus>;
    public readonly createdTs: number;

    constructor(
        windowMs: number,
        bucketMs: number,
        counterByBucket: Map<SlidingWindowBucket, SlidingWindowStatus>,
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
        let matchBucket: SlidingWindowBucket | undefined;
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
                new SlidingWindowStatus(new AtomicLong(count), now)
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
                new SlidingWindowStatus(new AtomicLong(0), createdTs)
            );
        }

        return windowCounter;
    }

    // True if now is in range of bucket duration
    static isValidForUpdate(
        bucket: InstanceType<typeof SlidingWindowBucket>,
        status: InstanceType<typeof SlidingWindowStatus>,
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
        bucket: InstanceType<typeof SlidingWindowBucket>,
        status: InstanceType<typeof SlidingWindowStatus>,
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
    ): Map<InstanceType<typeof SlidingWindowBucket>, InstanceType<typeof SlidingWindowStatus>> {
        const buckets = PartitionRange.partition(
            new SlidingWindowBucket(0, windowMs),
            0,
            windowMs,
            bucketMs,
            (from, to) => new SlidingWindowBucket(from, to)
        );

        // Java collector throws on duplicates; we guard by value
        const seen = new Set<string>();
        const map = new Map<InstanceType<typeof SlidingWindowBucket>, InstanceType<typeof SlidingWindowStatus>>();

        for (const bucket of buckets) {
            const key = `${bucket.from}-${bucket.to}`;
            if (seen.has(key)) {
                throw new Error('No duplicate buckets allowed');
            }
            seen.add(key);

            map.set(bucket, new SlidingWindowStatus(new AtomicLong(0), createdTs));
        }

        return map;
    }
}
