import { describe, expect, it } from 'vitest';

import { readUntil } from '@shared/resilience/read-until.ts';

import { createManualTimers, type ManualTimers } from './manual-timers.ts';

/** Lets a resumed read loop run up to its next wait. */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) {
        await Promise.resolve();
    }
}

async function advance(timers: ManualTimers, byMs: number): Promise<void> {
    await timers.advance(byMs);
    await settle();
}

describe('read until', () => {
    it('answers the first read when it is accepted, waiting for nothing', async () => {
        const timers = createManualTimers(0);
        let reads = 0;

        const outcome = await readUntil({
            timers,
            intervalMs: 250,
            deadlineAtMs: 1_000,
            read: async () => {
                reads += 1;
                return 'ready';
            },
            accept: (value) => value === 'ready'
        });

        expect(outcome).toEqual({ kind: 'accepted', value: 'ready' });
        expect(reads).toBe(1);
        expect(timers.pendingCount()).toBe(0);
    });

    it('reads again one interval after each read it did not accept, and answers the accepted value narrowed', async () => {
        const timers = createManualTimers(0);
        const readsAtMs: number[] = [];
        const values = [undefined, undefined, 'third'];

        const pending = readUntil({
            timers,
            intervalMs: 250,
            deadlineAtMs: 10_000,
            read: async () => {
                readsAtMs.push(timers.nowMs());
                return values[readsAtMs.length - 1];
            },
            accept: (value) => value !== undefined
        });
        await settle();
        expect(readsAtMs).toEqual([0]);
        await advance(timers, 249);
        expect(readsAtMs).toEqual([0]);
        await advance(timers, 1);
        expect(readsAtMs).toEqual([0, 250]);
        await advance(timers, 250);
        const outcome = await pending;

        expect(readsAtMs).toEqual([0, 250, 500]);
        expect(outcome.kind === 'accepted' ? outcome.value.toUpperCase() : outcome).toBe('THIRD');
        expect(timers.pendingCount()).toBe(0);
    });

    it('answers the timed-out value at the deadline without starting a read at or after it', async () => {
        const timers = createManualTimers(0);
        const readsAtMs: number[] = [];

        const pending = readUntil({
            timers,
            intervalMs: 250,
            deadlineAtMs: 1_000,
            read: async () => {
                readsAtMs.push(timers.nowMs());
                return false;
            },
            accept: (value) => value
        });
        await settle();
        for (let step = 0; step < 4; step += 1) {
            await advance(timers, 250);
        }

        await expect(pending).resolves.toEqual({ kind: 'timed-out' });
        expect(readsAtMs).toEqual([0, 250, 500, 750]);
        expect(timers.pendingCount()).toBe(0);
    });

    it('accepts a read that started before the deadline and resolves after it', async () => {
        const timers = createManualTimers(0);
        const readsAtMs: number[] = [];
        const lateRead = Promise.withResolvers<boolean>();

        const pending = readUntil({
            timers,
            intervalMs: 250,
            deadlineAtMs: 1_000,
            read: async () => {
                readsAtMs.push(timers.nowMs());
                return readsAtMs.length < 4 ? false : await lateRead.promise;
            },
            accept: (value) => value
        });
        await settle();
        for (let step = 0; step < 3; step += 1) {
            await advance(timers, 250);
        }
        expect(readsAtMs).toEqual([0, 250, 500, 750]);
        await advance(timers, 500);
        lateRead.resolve(true);

        await expect(pending).resolves.toEqual({ kind: 'accepted', value: true });
        expect(timers.nowMs()).toBe(1_250);
        expect(readsAtMs).toEqual([0, 250, 500, 750]);
    });

    it('answers the timed-out value without a read when the deadline has already passed', async () => {
        const timers = createManualTimers(2_000);
        let reads = 0;

        const outcome = await readUntil({
            timers,
            intervalMs: 250,
            deadlineAtMs: 2_000,
            read: async () => {
                reads += 1;
                return true;
            },
            accept: (value) => value
        });

        expect(outcome).toEqual({ kind: 'timed-out' });
        expect(reads).toBe(0);
    });

    // The caller owns its read's failure: the loop neither retries nor converts it, and reads no more.
    it('rejects with a read\'s failure and starts no further read', async () => {
        const timers = createManualTimers(0);
        const failure = new Error('snapshot read failed');
        let reads = 0;

        const pending = readUntil({
            timers,
            intervalMs: 250,
            deadlineAtMs: 10_000,
            read: async () => {
                reads += 1;
                if (reads === 2) {
                    throw failure;
                }
                return false;
            },
            accept: (value) => value
        });
        const rejection = expect(pending).rejects.toBe(failure);
        await settle();
        await advance(timers, 250);

        await rejection;
        await advance(timers, 1_000);
        expect(reads).toBe(2);
        expect(timers.pendingCount()).toBe(0);
    });

    it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])('refuses the interval %s before reading', async (intervalMs) => {
        const timers = createManualTimers(0);
        let reads = 0;

        await expect(readUntil({
            timers,
            intervalMs,
            deadlineAtMs: 1_000,
            read: async () => {
                reads += 1;
                return false;
            },
            accept: (value) => value
        })).rejects.toThrow(TypeError);
        expect(reads).toBe(0);
    });
});
