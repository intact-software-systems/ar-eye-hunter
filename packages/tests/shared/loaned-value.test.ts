import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoanedValue } from '@shared/cache/LoanedValue.ts';

describe('LoanedValue', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces concurrent gets and refreshes again after expiry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const firstRefresh = createDeferred<number>();
        const secondRefresh = createDeferred<number>();
        const refreshes = [firstRefresh, secondRefresh];
        let calls = 0;
        const seenCurrent: Array<number | undefined> = [];

        const loan = new LoanedValue<number>(
            async (current) => {
                seenCurrent.push(current);
                const deferred = refreshes[calls];
                calls += 1;
                return deferred.promise;
            },
            {
                ttlMs: 100,
            },
        );

        const first = loan.get();
        const second = loan.get();

        expect(calls).toBe(1);
        expect(loan.refreshing()).toBe(true);

        firstRefresh.resolve(7);

        await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
        expect(loan.refreshing()).toBe(false);
        expect(await loan.get()).toBe(7);
        expect(calls).toBe(1);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));

        const third = loan.get();
        expect(calls).toBe(2);

        secondRefresh.resolve(9);

        await expect(third).resolves.toBe(9);
        expect(seenCurrent).toEqual([undefined, 7]);
    });

    it('supports override refreshers and rejects nullish refresh results', async () => {
        const loan = new LoanedValue<number>(async (current) => (current ?? 0) + 1);

        expect(await loan.get()).toBe(1);
        expect(await loan.refreshWith(async (current) => (current ?? 0) + 10)).toBe(
            11,
        );
        expect(loan.peek()).toBe(11);

        await expect(
            loan.refreshWith(async () => undefined as never),
        ).rejects.toThrow('Refresher returned null or undefined');
        expect(loan.peek()).toBe(11);
    });

    it('treats invalid cached values as expired and removable', async () => {
        const loan = new LoanedValue<number>(async () => -1, {
            isValid: (value) => value > 0,
        });

        await expect(loan.get()).resolves.toBe(-1);
        expect(loan.read()).toBeUndefined();
        expect(loan.expired()).toBe(true);
        expect(loan.takeIfExpired()).toBe(-1);
        expect(loan.hasValue()).toBe(false);
    });
});

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error?: unknown) => void;

    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}
