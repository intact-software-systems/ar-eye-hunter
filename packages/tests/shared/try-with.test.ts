import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    RetryableConflictError,
    tryRunInIntervals,
    tryWith,
    TryWithExhaustedError,
    TryWithPolicy,
    tryWithPolicy,
} from '@shared/resilience/TryWith.ts';

describe('TryWith', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('retries until the handler succeeds', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        let attempts = 0;
        const promise = tryWith(
            () => {
                attempts += 1;

                if (attempts < 3) {
                    throw new Error('retry');
                }

                return 'ok';
            },
            10,
            5,
        );

        expect(attempts).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(2);

        await vi.advanceTimersByTimeAsync(10);
        await expect(promise).resolves.toBe('ok');
        expect(attempts).toBe(3);
    });

    it('stops retrying once maxAttempts is reached', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        let attempts = 0;
        const handled = tryWith(
            () => {
                attempts += 1;
                throw new Error('still failing');
            },
            10,
            2,
        ).catch((error) => error);

        expect(attempts).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        await expect(handled).resolves.toEqual({ error: 'Unable to do it' });
        expect(attempts).toBe(2);

        await vi.advanceTimersByTimeAsync(100);
        expect(attempts).toBe(2);
    });

    it('retries async rejections until the handler succeeds', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        let attempts = 0;
        const promise = tryWith(
            async () => {
                attempts += 1;

                if (attempts < 3) {
                    throw new Error('retry');
                }

                return 'ok';
            },
            10,
            5,
        );

        expect(attempts).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(2);

        await vi.advanceTimersByTimeAsync(20);
        await expect(promise).resolves.toBe('ok');
        expect(attempts).toBe(3);
    });

    it('supports fluent retry policies for retryable errors', async () => {
        vi.useFakeTimers();

        let attempts = 0;
        const promise = tryWithPolicy(
            () => {
                attempts += 1;

                if (attempts < 3) {
                    throw new RetryableConflictError('conflict');
                }

                return 'ok';
            },
            TryWithPolicy.defaults()
                .maxAttempts(5)
                .initialDelayMsecs(10)
                .jitterRatio(0)
                .retryIf((error) => error instanceof RetryableConflictError),
        );

        expect(attempts).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(2);

        await vi.advanceTimersByTimeAsync(20);
        await expect(promise).resolves.toBe('ok');
        expect(attempts).toBe(3);
    });

    it('does not retry non-retryable errors when a policy rejects them', async () => {
        vi.useFakeTimers();

        let attempts = 0;
        const promise = tryWithPolicy(
            () => {
                attempts += 1;
                throw new Error('fatal');
            },
            TryWithPolicy.defaults()
                .maxAttempts(5)
                .initialDelayMsecs(10)
                .retryIf((error) => error instanceof RetryableConflictError),
        );

        await expect(promise).rejects.toThrow('fatal');
        expect(attempts).toBe(1);

        await vi.advanceTimersByTimeAsync(100);
        expect(attempts).toBe(1);
    });

    it('raises a typed exhausted error with retry context', async () => {
        vi.useFakeTimers();

        let attempts = 0;
        const handled = tryWithPolicy(
            () => {
                attempts += 1;
                throw new RetryableConflictError('conflict');
            },
            TryWithPolicy.defaults()
                .label('test-commit')
                .maxAttempts(2)
                .initialDelayMsecs(10)
                .jitterRatio(0)
                .retryIf((error) => error instanceof RetryableConflictError),
        ).catch((error) => error);

        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(10);

        const error = await handled;
        expect(error).toBeInstanceOf(TryWithExhaustedError);
        expect(error.context).toMatchObject({
            label: 'test-commit',
            attempt: 2,
            maxAttempts: 2,
        });
        expect(attempts).toBe(2);
    });

    it('continues to invoke a successful handler at the configured interval', async () => {
        vi.useFakeTimers();

        const handler = vi.fn(() => 'tick');
        const promise = tryRunInIntervals(handler, 50, 10, 3);

        await expect(promise).resolves.toBe('tick');
        expect(handler).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(50);
        expect(handler).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(50);
        expect(handler).toHaveBeenCalledTimes(3);
    });

    it('retries async rejections before the first successful interval run', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        let attempts = 0;
        const promise = tryRunInIntervals(
            async () => {
                attempts += 1;

                if (attempts < 3) {
                    throw new Error('retry');
                }

                return 'ok';
            },
            50,
            10,
            5,
        );

        expect(attempts).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(2);

        await vi.advanceTimersByTimeAsync(20);
        await expect(promise).resolves.toBe('ok');
        expect(attempts).toBe(3);
    });

    it('retries async rejections after the loop has already started', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        let attempts = 0;
        const promise = tryRunInIntervals(
            async () => {
                attempts += 1;

                if (attempts === 2) {
                    throw new Error('retry');
                }

                return `tick-${attempts}`;
            },
            50,
            10,
            5,
        );

        await expect(promise).resolves.toBe('tick-1');
        expect(attempts).toBe(1);

        await vi.advanceTimersByTimeAsync(50);
        expect(attempts).toBe(2);

        await vi.advanceTimersByTimeAsync(9);
        expect(attempts).toBe(2);

        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toBe(3);
    });
});
