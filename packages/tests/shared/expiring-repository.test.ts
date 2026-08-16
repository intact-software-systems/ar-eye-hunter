import { describe, expect, it, vi } from 'vitest';
import { ExpiringRepository } from '@shared/cache/expiring-repository.ts';
import { LatestValue } from '@shared/cache/LatestValue.ts';

interface Decision {
    readonly claimed: boolean;
}

describe('ExpiringRepository', () => {
    // The gap that stopped LoanedRepository being usable from a synchronous
    // caller: a value written on one line has to be readable on the next,
    // without awaiting anything.
    it('makes an accepted value readable synchronously', () => {
        const repository = new ExpiringRepository<string, Decision>();

        repository.accept({
            key: 'work-1',
            value: { claimed: true },
            nowEpochMs: 1_000,
            expireAtEpochMs: 60_000,
        });

        expect(repository.read('work-1', 1_000)).toEqual({ claimed: true });
        expect(repository.peek('work-1')).toEqual({ claimed: true });
        expect(repository.size()).toBe(1);
    });

    // Each entry carries its own absolute deadline rather than sharing one
    // relative TTL, which is what durable work expiry actually looks like.
    it('expires each entry on its own absolute deadline', () => {
        const repository = new ExpiringRepository<string, Decision>();

        repository.accept({
            key: 'short',
            value: { claimed: true },
            nowEpochMs: 0,
            expireAtEpochMs: 100,
        });
        repository.accept({
            key: 'long',
            value: { claimed: false },
            nowEpochMs: 0,
            expireAtEpochMs: 10_000,
        });

        expect(repository.read('short', 99)).toEqual({ claimed: true });
        expect(repository.read('short', 100)).toBeUndefined();
        expect(repository.read('long', 100)).toEqual({ claimed: false });
    });

    // A read past the deadline must never answer, whether or not a prune has
    // reached the entry yet. Reading also drops it, so the miss is not repaid
    // by a growing map.
    it('never answers from an expired entry and drops it on read', () => {
        const repository = new ExpiringRepository<string, Decision>();

        repository.accept({
            key: 'work-1',
            value: { claimed: true },
            nowEpochMs: 0,
            expireAtEpochMs: 100,
        });
        expect(repository.size()).toBe(1);

        expect(repository.read('work-1', 500)).toBeUndefined();
        expect(repository.size()).toBe(0);
    });

    it('reads or creates in one synchronous step', () => {
        const repository = new ExpiringRepository<string, Decision>();
        const create = vi.fn(() => ({ claimed: true }));

        const first = repository.readOrAccept({
            key: 'work-1',
            value: { claimed: true },
            nowEpochMs: 0,
            expireAtEpochMs: 100,
            create,
        });
        const second = repository.readOrAccept({
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

    // Bulk reclamation is amortized, so the O(N) scan stops being per-write.
    // The window is driven by the passed instant, never by wall time.
    it('rate limits the bulk prune on the supplied clock', () => {
        const repository = new ExpiringRepository<string, Decision>({
            pruneWindowMs: 20_000,
            prunesPerWindow: 1,
        });

        for (const index of [1, 2, 3]) {
            repository.accept({
                key: `work-${index}`,
                value: { claimed: true },
                nowEpochMs: 0,
                expireAtEpochMs: 100,
            });
        }

        expect(repository.deleteExpiredWhenDue(1_000)).toBe(3);
        expect(repository.readCounts()).toEqual({ retained: 0, pruneRuns: 1 });

        repository.accept({
            key: 'work-4',
            value: { claimed: true },
            nowEpochMs: 1_000,
            expireAtEpochMs: 1_100,
        });

        expect(repository.deleteExpiredWhenDue(5_000)).toBe(0);
        expect(repository.readCounts()).toEqual({ retained: 1, pruneRuns: 1 });

        expect(repository.deleteExpiredWhenDue(30_000)).toBe(1);
        expect(repository.readCounts()).toEqual({ retained: 0, pruneRuns: 2 });
    });

    // The validity predicate receives the instant, so a whole prune scan is
    // judged against one time rather than each entry fetching its own.
    it('passes the deciding instant into the validity predicate', () => {
        const seen: number[] = [];
        const repository = new ExpiringRepository<string, Decision>({
            isValid: (_value, nowEpochMs) => {
                seen.push(nowEpochMs);
                return true;
            },
        });

        repository.accept({ key: 'a', value: { claimed: true }, nowEpochMs: 0 });
        repository.accept({ key: 'b', value: { claimed: true }, nowEpochMs: 0 });
        repository.deleteExpired(7_777);

        expect(seen).toEqual([7_777, 7_777]);
    });

    it('honours a relative ttl when no deadline is supplied', () => {
        const repository = new ExpiringRepository<string, Decision>({ ttlMs: 100 });

        repository.accept({ key: 'a', value: { claimed: true }, nowEpochMs: 1_000 });

        expect(repository.read('a', 1_100)).toEqual({ claimed: true });
        expect(repository.read('a', 1_101)).toBeUndefined();
    });

    // A zero instant is a legal clock reading. The previous sentinel treated
    // valueStartMs === 0 as "no value", so anything written at epoch zero read
    // back as expired.
    it('treats a zero instant as a real time rather than an empty slot', () => {
        const repository = new ExpiringRepository<string, Decision>();

        repository.accept({ key: 'a', value: { claimed: true }, nowEpochMs: 0 });

        expect(repository.read('a', 0)).toEqual({ claimed: true });
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
