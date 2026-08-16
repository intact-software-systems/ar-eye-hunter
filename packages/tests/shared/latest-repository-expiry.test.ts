import { describe, expect, it, vi } from 'vitest';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { LatestValue } from '@shared/cache/LatestValue.ts';

interface Decision {
    readonly claimed: boolean;
}

describe('LatestRepository expiry surface', () => {
    // The gap that stopped LoanedRepository being usable from a synchronous
    // caller: a value written on one line has to be readable on the next,
    // without awaiting anything.
    it('makes an accepted value readable synchronously', () => {
        const repository = new LatestRepository<string, Decision>();

        repository.acceptAt({
            key: 'work-1',
            value: { claimed: true },
            nowEpochMs: 1_000,
            expireAtEpochMs: 60_000,
        });

        expect(repository.readAt('work-1', 1_000)).toEqual({ claimed: true });
        expect(repository.peek('work-1')).toEqual({ claimed: true });
        expect(repository.size()).toBe(1);
    });

    // Each entry carries its own absolute deadline rather than sharing one
    // relative TTL, which is what durable work expiry actually looks like.
    it('expires each entry on its own absolute deadline', () => {
        const repository = new LatestRepository<string, Decision>();

        repository.acceptAt({
            key: 'short',
            value: { claimed: true },
            nowEpochMs: 0,
            expireAtEpochMs: 100,
        });
        repository.acceptAt({
            key: 'long',
            value: { claimed: false },
            nowEpochMs: 0,
            expireAtEpochMs: 10_000,
        });

        expect(repository.readAt('short', 99)).toEqual({ claimed: true });
        expect(repository.readAt('short', 100)).toBeUndefined();
        expect(repository.readAt('long', 100)).toEqual({ claimed: false });
    });

    // A read past the deadline must never answer, whether or not a prune has
    // reached the entry yet. Reading also drops it, so the miss is not repaid
    // by a growing map.
    it('never answers from an expired entry and drops it on read', () => {
        const repository = new LatestRepository<string, Decision>();

        repository.acceptAt({
            key: 'work-1',
            value: { claimed: true },
            nowEpochMs: 0,
            expireAtEpochMs: 100,
        });
        expect(repository.size()).toBe(1);

        expect(repository.readAt('work-1', 500)).toBeUndefined();
        expect(repository.size()).toBe(0);
    });

    it('reads or creates in one synchronous step', () => {
        const repository = new LatestRepository<string, Decision>();
        const create = vi.fn(() => ({ claimed: true }));

        const first = repository.readOrAcceptAt({
            key: 'work-1',
            value: { claimed: true },
            nowEpochMs: 0,
            expireAtEpochMs: 100,
            create,
        });
        const second = repository.readOrAcceptAt({
            key: 'work-1',
            value: { claimed: true },
            nowEpochMs: 50,
            expireAtEpochMs: 100,
            create,
        });

        expect(first).toEqual({ claimed: true });
        expect(second).toEqual({ claimed: true });
        expect(create).toHaveBeenCalledTimes(1);
    });

    // Writes carry the eviction, on a budget, so the O(N) scan is amortized
    // instead of running per write. The budget window is driven by the passed
    // instant, never by wall time.
    it('evicts from the write path on a rate-limited budget', () => {
        const repository = new LatestRepository<string, Decision>({
            evictWindowMs: 20_000,
            evictsPerWindow: 1,
        });

        for (const [index, nowEpochMs] of [[1, 0], [2, 10], [3, 20]] as const) {
            repository.acceptAt({
                key: `work-${index}`,
                value: { claimed: true },
                nowEpochMs,
                expireAtEpochMs: 100,
            });
        }

        // The first write spent this window's single eviction, so the later two
        // wrote without scanning.
        expect(repository.readEvictionCounts()).toEqual({ retained: 3, evictionRuns: 1 });

        // Past both the entries' deadlines and the budget window, so this write
        // scans and reclaims all three.
        repository.acceptAt({
            key: 'work-4',
            value: { claimed: true },
            nowEpochMs: 30_000,
            expireAtEpochMs: 60_000,
        });

        expect(repository.readEvictionCounts()).toEqual({ retained: 1, evictionRuns: 2 });
    });

    it('can opt out of write-path eviction entirely', () => {
        const repository = new LatestRepository<string, Decision>({ evictsPerWindow: 0 });

        repository.acceptAt({
            key: 'a',
            value: { claimed: true },
            nowEpochMs: 0,
            expireAtEpochMs: 100,
        });
        repository.acceptAt({
            key: 'b',
            value: { claimed: true },
            nowEpochMs: 500,
            expireAtEpochMs: 600,
        });

        expect(repository.readEvictionCounts()).toEqual({ retained: 2, evictionRuns: 0 });
        expect(repository.deleteExpiredAt(1_000)).toBe(2);
    });

    // The validity predicate receives the instant, so a whole prune scan is
    // judged against one time rather than each entry fetching its own.
    it('passes the deciding instant into the validity predicate', () => {
        const seen: number[] = [];
        const repository = new LatestRepository<string, Decision>({
            evictsPerWindow: 0,
            isValid: (_value, nowEpochMs) => {
                seen.push(nowEpochMs);
                return true;
            },
        });

        repository.acceptAt({ key: 'a', value: { claimed: true }, nowEpochMs: 0 });
        repository.acceptAt({ key: 'b', value: { claimed: true }, nowEpochMs: 0 });
        repository.deleteExpiredAt(7_777);

        expect(seen).toEqual([7_777, 7_777]);
    });

    // The two expiry mechanisms differ at the boundary and this pins it: an
    // absolute deadline expires AT its instant, a relative ttl expires one
    // millisecond after elapsing. The deadline is inclusive because every
    // hand-rolled store in this repo tests `expireAt <= now`; the ttl rule is
    // older than that and unchanged here. Mixing both on one entry means the
    // deadline decides first.
    it('expires a deadline inclusively and a ttl exclusively', () => {
        const deadline = new LatestRepository<string, Decision>({ evictsPerWindow: 0 });
        deadline.acceptAt({
            key: 'a',
            value: { claimed: true },
            nowEpochMs: 0,
            expireAtEpochMs: 100,
        });
        expect(deadline.readAt('a', 99)).toEqual({ claimed: true });
        expect(deadline.readAt('a', 100)).toBeUndefined();

        const ttl = new LatestRepository<string, Decision>({ ttlMs: 100, evictsPerWindow: 0 });
        ttl.acceptAt({ key: 'a', value: { claimed: true }, nowEpochMs: 0 });
        expect(ttl.readAt('a', 100)).toEqual({ claimed: true });
        expect(ttl.readAt('a', 101)).toBeUndefined();
    });

    it('honours a relative ttl when no deadline is supplied', () => {
        const repository = new LatestRepository<string, Decision>({ ttlMs: 100 });

        repository.acceptAt({ key: 'a', value: { claimed: true }, nowEpochMs: 1_000 });

        expect(repository.readAt('a', 1_100)).toEqual({ claimed: true });
        expect(repository.readAt('a', 1_101)).toBeUndefined();
    });

    // A zero instant is a legal clock reading. The previous sentinel treated
    // valueStartMs === 0 as "no value", so anything written at epoch zero read
    // back as expired.
    it('treats a zero instant as a real time rather than an empty slot', () => {
        const repository = new LatestRepository<string, Decision>();

        repository.acceptAt({ key: 'a', value: { claimed: true }, nowEpochMs: 0 });

        expect(repository.readAt('a', 0)).toEqual({ claimed: true });
    });

    it('leaves the wall-clock LatestValue entry points behaving as before', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const value = new LatestValue<number>({ ttlMs: 100 });
        value.accept(7);
        expect(value.read()).toBe(7);
        expect(value.expired()).toBe(false);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
        expect(value.read()).toBeUndefined();
        expect(value.expired()).toBe(true);
        expect(value.peek()).toBe(7);

        vi.useRealTimers();
    });
});
