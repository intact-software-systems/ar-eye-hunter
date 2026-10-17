import { describe, expect, it } from 'vitest';

import { ThrottledFlush, ThrottledFlushStoppedError } from '@shared/resilience/throttled-flush.ts';

import { createManualTimers } from './manual-timers.ts';

interface WriteLog {
    readonly startedAtMs: number[];
    readonly completedAtMs: number[];
}

/** A flush whose writes either complete at once or stay open until the test finishes them. */
function createFlush(minIntervalMs: number, writesStayOpen = false) {
    const timers = createManualTimers(1_000);
    const log: WriteLog = { startedAtMs: [], completedAtMs: [] };
    const openWrites: (() => void)[] = [];
    const flush = new ThrottledFlush({
        timers,
        write: () => {
            log.startedAtMs.push(timers.nowMs());
            return new Promise<void>((resolve) => {
                const finish = (): void => {
                    log.completedAtMs.push(timers.nowMs());
                    resolve();
                };
                if (writesStayOpen) {
                    openWrites.push(finish);
                    return;
                }
                finish();
            });
        }
    }, { minIntervalMs });
    /** Completes the oldest open write and lets its settlement run. */
    const finishWrite = async (): Promise<void> => {
        openWrites.shift()?.();
        await settle();
    };
    return { timers, log, flush, finishWrite };
}

async function settle(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve();
    }
}

describe('throttled flush', () => {
    it('writes at once when the interval since the last write began has already passed', async () => {
        const { timers, log, flush } = createFlush(150);

        const first = flush.mark();
        await timers.advance(0);
        await first;
        await timers.advance(400);
        const afterQuiet = flush.mark();
        await timers.advance(0);

        expect(log.startedAtMs).toEqual([1_000, 1_400]);
        await afterQuiet;
    });

    it('holds a mark inside the interval until the last write start plus the interval', async () => {
        const { timers, log, flush } = createFlush(150);

        const first = flush.mark();
        await timers.advance(0);
        await first;
        await timers.advance(40);
        const inside = flush.mark();
        await timers.advance(109);
        expect(log.startedAtMs).toEqual([1_000]);

        await timers.advance(1);
        await inside;
        expect(log.startedAtMs).toEqual([1_000, 1_150]);
    });

    it('joins every mark inside the interval into one trailing write', async () => {
        const { timers, log, flush } = createFlush(150);

        const leading = flush.mark();
        await timers.advance(0);
        await leading;
        await timers.advance(20);
        const second = flush.mark();
        await timers.advance(100);
        const third = flush.mark();
        expect(log.startedAtMs).toEqual([1_000]);

        await timers.advance(30);
        await Promise.all([second, third]);
        expect(log.startedAtMs).toEqual([1_000, 1_150]);
        expect(timers.pendingCount()).toBe(0);
    });

    it('settles the timer that starts a write only once that write completed', async () => {
        const timers = createManualTimers(1_000);
        let completed = false;
        const flush = new ThrottledFlush({
            timers,
            write: async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 5));
                completed = true;
            }
        }, { minIntervalMs: 150 });

        void flush.mark();
        await timers.advance(0);

        expect(completed).toBe(true);
    });

    it('re-arms a write for a mark made during the write, one write in flight at a time', async () => {
        const { timers, log, flush, finishWrite } = createFlush(150, true);

        const first = flush.mark();
        void timers.advance(0);
        await settle();
        expect(log.startedAtMs).toEqual([1_000]);
        await timers.advance(10);
        const duringWrite = flush.mark();
        expect(log.startedAtMs).toEqual([1_000]);

        await timers.advance(30);
        await finishWrite();
        await first;
        expect(log.completedAtMs).toEqual([1_040]);
        void timers.advance(110);
        await settle();
        expect(log.startedAtMs).toEqual([1_000, 1_150]);
        await finishWrite();
        await duringWrite;
    });

    it('pulls a scheduled write to now on an urgent mark', async () => {
        const { timers, log, flush } = createFlush(150);

        const leading = flush.mark();
        await timers.advance(0);
        await leading;
        await timers.advance(20);
        const scheduled = flush.mark();
        const urgent = flush.mark(true);
        await timers.advance(0);
        await Promise.all([scheduled, urgent]);

        expect(log.startedAtMs).toEqual([1_000, 1_020]);
        expect(timers.pendingCount()).toBe(0);
    });

    it('writes an urgent mark made during a write as soon as that write completes', async () => {
        const { timers, log, flush, finishWrite } = createFlush(150, true);

        const first = flush.mark(true);
        void timers.advance(0);
        await settle();
        expect(log.startedAtMs).toEqual([1_000]);
        const joined = flush.mark(true);
        await timers.advance(40);
        await finishWrite();
        await first;
        void timers.advance(0);
        await settle();
        expect(log.startedAtMs).toEqual([1_000, 1_040]);
        await finishWrite();
        await joined;
    });

    it('rejects every mark the failed write covered and keeps serving later marks', async () => {
        const timers = createManualTimers(0);
        let attempts = 0;
        const flush = new ThrottledFlush({
            timers,
            write: () => {
                attempts += 1;
                return attempts === 1 ? Promise.reject(new Error('disk full')) : Promise.resolve();
            }
        }, { minIntervalMs: 10 });

        const failed = flush.mark();
        const failedToo = flush.mark();
        await timers.advance(10);
        await expect(failed).rejects.toThrow('disk full');
        await expect(failedToo).rejects.toThrow('disk full');

        const recovered = flush.mark();
        await timers.advance(10);
        await expect(recovered).resolves.toBeUndefined();
        expect(attempts).toBe(2);
    });

    it('drains on stop: a scheduled write runs at once, a write in flight is joined, later marks are refused', async () => {
        const { timers, log, flush, finishWrite } = createFlush(150, true);

        const leading = flush.mark();
        void timers.advance(0);
        await settle();
        await finishWrite();
        await leading;
        await timers.advance(20);
        const scheduled = flush.mark();
        const stopping = flush.stop();
        await settle();
        await timers.advance(40);
        await finishWrite();
        await stopping;
        await scheduled;

        expect(log.startedAtMs).toEqual([1_000, 1_020]);
        expect(log.completedAtMs).toEqual([1_000, 1_060]);
        expect(timers.pendingCount()).toBe(0);
        await expect(flush.mark()).rejects.toThrow(ThrottledFlushStoppedError);
    });

    it('stop drains a mark made during the write it joined', async () => {
        const { timers, log, flush, finishWrite } = createFlush(150, true);

        const first = flush.mark();
        void timers.advance(0);
        await settle();
        const duringWrite = flush.mark();
        const stopping = flush.stop();
        await timers.advance(40);
        await finishWrite();
        await first;
        await timers.advance(40);
        await finishWrite();
        await stopping;
        await duringWrite;

        expect(log.startedAtMs).toEqual([1_000, 1_040]);
    });

    it('covers a mark made while stop drains', async () => {
        const { timers, log, flush, finishWrite } = createFlush(150, true);

        void flush.mark();
        const stopping = flush.stop();
        await settle();
        await timers.advance(10);
        const whileStopping = flush.mark();
        await finishWrite();
        await timers.advance(10);
        await finishWrite();
        await stopping;
        await whileStopping;

        expect(log.startedAtMs).toEqual([1_000, 1_010]);
        expect(timers.pendingCount()).toBe(0);
    });

    it('stops idle without a write', async () => {
        const { log, flush } = createFlush(150);

        await flush.stop();

        expect(log.startedAtMs).toEqual([]);
    });
});
