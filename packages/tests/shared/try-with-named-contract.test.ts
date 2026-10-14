import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    tryRunInIntervals,
    tryWith,
    TryWithExhaustedError
} from '@shared/resilience/try-with-policy.ts';

describe('named retry contract', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('uses canonical exponential delays from the first retry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const times: number[] = [];
        const promise = tryWith({
            handler: () => {
                times.push(Date.now());
                if (times.length < 4) {
                    throw new Error('retry');
                }
                return 'done';
            },
            retryIntervalMsecs: 10,
            maxAttempts: 4,
            maxRetryIntervalMsecs: 80
        });
        await vi.advanceTimersByTimeAsync(70);
        await expect(promise).resolves.toBe('done');
        expect(times).toEqual([0, 10, 30, 70]);
    });

    it.each([
        { cap: 5, random: 0.5, retryAt: 5 },
        { cap: 80, random: 0, retryAt: 8 }
    ])('caps and jitters the first retry at $retryAt ms', async ({ cap, random, retryAt }) => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(random);
        const times: number[] = [];
        const promise = tryWith({
            handler: () => {
                times.push(Date.now());
                if (times.length === 1) {
                    throw new Error('retry');
                }
                return 'done';
            },
            retryIntervalMsecs: 10,
            maxAttempts: 2,
            maxRetryIntervalMsecs: cap
        });
        await vi.advanceTimersByTimeAsync(10);
        await expect(promise).resolves.toBe('done');
        expect(times).toEqual([0, retryAt]);
    });

    it('retains the last thrown cause and context on exhaustion', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const first = new Error('first');
        const last = { failure: 'last' };
        let attempts = 0;
        const handled = tryWith({
            handler: () => {
                attempts += 1;
                throw attempts === 1 ? first : last;
            },
            retryIntervalMsecs: 10,
            maxAttempts: 2,
            maxRetryIntervalMsecs: 80
        }).catch((error) => error);
        await vi.advanceTimersByTimeAsync(10);
        const error = await handled;
        expect(error).toBeInstanceOf(TryWithExhaustedError);
        expect(error.cause).toBe(last);
        expect(error.context).toMatchObject({ attempt: 2, maxAttempts: 2, elapsedMsecs: 10 });
        expect(error.context.error).toBe(last);
    });

    it('preserves positive fractional attempt counting', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        let attempts = 0;
        const promise = tryWith({
            handler: () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new Error('retry');
                }
                return 'third';
            },
            retryIntervalMsecs: 10,
            maxAttempts: 2.5,
            maxRetryIntervalMsecs: 80
        });
        await vi.advanceTimersByTimeAsync(30);
        await expect(promise).resolves.toBe('third');
        expect(attempts).toBe(3);
    });

    it('accepts an explicit huge attempt limit without truncation', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        let attempts = 0;
        const promise = tryWith({
            handler: () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new Error('retry');
                }
                return 'third';
            },
            retryIntervalMsecs: 10,
            maxAttempts: Number.MAX_VALUE,
            maxRetryIntervalMsecs: 80
        });
        await vi.advanceTimersByTimeAsync(30);
        await expect(promise).resolves.toBe('third');
        expect(attempts).toBe(3);
    });

    it('uses the fixed periodic cap on the first retry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const times: number[] = [];
        const promise = tryRunInIntervals({
            handler: () => {
                times.push(Date.now());
                if (times.length === 1) {
                    throw new Error('retry');
                }
                return 'first';
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 30_000,
            maxAttempts: 2
        });
        await vi.advanceTimersByTimeAsync(20_000);
        await expect(promise).resolves.toBe('first');
        expect(times).toEqual([0, 20_000]);
    });

    it('preserves fractional periodic attempts with the canonical schedule', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const times: number[] = [];
        const promise = tryRunInIntervals({
            handler: () => {
                times.push(Date.now());
                if (times.length < 3) {
                    throw new Error('retry');
                }
                return 'third';
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 10,
            maxAttempts: 2.5
        });
        await vi.advanceTimersByTimeAsync(30);
        await expect(promise).resolves.toBe('third');
        expect(times).toEqual([0, 10, 30]);
    });

    it('resolves the first result and spaces cycles from completion without overlap', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const times: number[] = [];
        const promise = tryRunInIntervals({
            handler: async () => {
                times.push(Date.now());
                await new Promise<void>((resolve) => setTimeout(resolve, 20));
                return `cycle-${times.length}`;
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 10,
            maxAttempts: 3
        });
        await vi.advanceTimersByTimeAsync(19);
        expect(times).toEqual([0]);
        await vi.advanceTimersByTimeAsync(1);
        await expect(promise).resolves.toBe('cycle-1');
        await vi.advanceTimersByTimeAsync(49);
        expect(times).toEqual([0]);
        await vi.advanceTimersByTimeAsync(1);
        expect(times).toEqual([0, 70]);
        await vi.advanceTimersByTimeAsync(70);
        expect(times).toEqual([0, 70, 140]);
    });

    it('resets retries for each cycle and retains the first settled result', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const times: number[] = [];
        const promise = tryRunInIntervals({
            handler: () => {
                times.push(Date.now());
                if (times.length % 3 !== 0) {
                    throw new Error('retry');
                }
                return `cycle-${times.length / 3}`;
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 10,
            maxAttempts: 3
        });
        await vi.advanceTimersByTimeAsync(30);
        await expect(promise).resolves.toBe('cycle-1');
        await vi.advanceTimersByTimeAsync(80);
        expect(times).toEqual([0, 10, 30, 80, 90, 110]);
        await expect(promise).resolves.toBe('cycle-1');
    });

    it('rejects typed exhaustion before the first successful cycle and stops', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const cause = new Error('failed cycle');
        let attempts = 0;
        const handled = tryRunInIntervals({
            handler: () => {
                attempts += 1;
                throw cause;
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 10,
            maxAttempts: 2
        }).catch((error) => error);
        await vi.advanceTimersByTimeAsync(200);
        const error = await handled;
        expect(error).toBeInstanceOf(TryWithExhaustedError);
        expect(error.cause).toBe(cause);
        expect(attempts).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops an exhausted later cycle without changing the first result', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const times: number[] = [];
        const promise = tryRunInIntervals({
            handler: () => {
                times.push(Date.now());
                if (times.length > 1) {
                    throw new Error('later cycle');
                }
                return 'first';
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 10,
            maxAttempts: 2
        });
        await expect(promise).resolves.toBe('first');
        await vi.advanceTimersByTimeAsync(200);
        expect(times).toEqual([0, 50, 60]);
        await expect(promise).resolves.toBe('first');
        expect(vi.getTimerCount()).toBe(0);
    });
});
