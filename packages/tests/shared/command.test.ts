import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CircuitBreakerOpenError,
    Command,
    CommandCancelledError,
    CommandTimedOutError,
    NullValueError,
    RateLimitExceededError,
} from '@shared/cache/Command.ts';

describe('Command', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('retries until the supplier succeeds and fires hooks in order', async () => {
        const events: string[] = [];
        const circuitBreaker = createCircuitBreakerStub();
        let attempts = 0;

        const command = new Command(
            () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new Error(`fail-${attempts}`);
                }
                return 'ok';
            },
            {
                maxAttempts: 3,
                circuitBreaker: circuitBreaker as never,
                hooks: {
                    onSubscribe: () => events.push('subscribe'),
                    onAttemptError: (_error, attempt) =>
                        events.push(`attempt:${attempt}`),
                    onSuccess: (value) => events.push(`success:${value}`),
                    onComplete: () => events.push('complete'),
                },
            },
        );

        await expect(command.run()).resolves.toBe('ok');

        expect(attempts).toBe(3);
        expect(events).toEqual([
            'subscribe',
            'attempt:1',
            'attempt:2',
            'success:ok',
            'complete',
        ]);
        expect(circuitBreaker.success).toHaveBeenCalledOnce();
        expect(circuitBreaker.failure).not.toHaveBeenCalled();
    });

    it('uses the fallback after retries are exhausted', async () => {
        const events: string[] = [];
        const circuitBreaker = createCircuitBreakerStub();

        const command = new Command(
            () => {
                throw new Error('boom');
            },
            {
                maxAttempts: 2,
                circuitBreaker: circuitBreaker as never,
                fallback: (error) => `fallback:${(error as Error).message}`,
                hooks: {
                    onFallback: (value) => events.push(`fallback:${value}`),
                    onComplete: () => events.push('complete'),
                },
            },
        );

        await expect(command.run()).resolves.toBe('fallback:boom');
        expect(events).toEqual(['fallback:fallback:boom', 'complete']);
        expect(circuitBreaker.success).toHaveBeenCalledOnce();
        expect(circuitBreaker.failure).not.toHaveBeenCalled();
    });

    it('times out long-running work', async () => {
        vi.useFakeTimers();

        const expectation = expect(
            new Command(
                () =>
                    new Promise((resolve) => {
                        setTimeout(() => resolve('late'), 50);
                    }),
                {
                    timeoutMs: 10,
                },
            ).run(),
        ).rejects.toThrow('Command timed out after 10 ms');

        await vi.advanceTimersByTimeAsync(10);

        await expectation;
    });

    it('aborts the active supplier signal when a timeout fires', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;

        const expectation = expect(
            new Command<string>(
                (attemptSignal) => {
                    signal = attemptSignal;
                    return new Promise<string>((_resolve, reject) => {
                        attemptSignal?.addEventListener(
                            'abort',
                            () => reject(attemptSignal.reason),
                        );
                    });
                },
                {
                    timeoutMs: 10,
                },
            ).run(),
        ).rejects.toBeInstanceOf(CommandTimedOutError);

        await vi.advanceTimersByTimeAsync(10);

        await expectation;
        expect(signal?.aborted).toBe(true);
        expect(signal?.reason).toBeInstanceOf(CommandTimedOutError);
    });

    it('aborts the active supplier signal when cancelled', async () => {
        let signal: AbortSignal | undefined;
        const command = new Command<string>((attemptSignal) => {
            signal = attemptSignal;
            return new Promise<string>((_resolve, reject) => {
                attemptSignal?.addEventListener(
                    'abort',
                    () => reject(attemptSignal.reason),
                );
            });
        });

        const run = command.run();
        await Promise.resolve();
        command.cancel();

        await expect(run).rejects.toBeInstanceOf(CommandCancelledError);
        expect(signal?.aborted).toBe(true);
        expect(signal?.reason).toBeInstanceOf(CommandCancelledError);
    });

    it('aborts the active supplier signal from a parent signal', async () => {
        const controller = new AbortController();
        let signal: AbortSignal | undefined;
        const command = new Command<string>(
            (attemptSignal) => {
                signal = attemptSignal;
                return new Promise<string>((_resolve, reject) => {
                    attemptSignal?.addEventListener(
                        'abort',
                        () => reject(attemptSignal.reason),
                    );
                });
            },
            {
                signal: controller.signal,
            },
        );

        const run = command.run();
        await Promise.resolve();
        controller.abort('parent-abort');

        await expect(run).rejects.toThrow('parent-abort');
        expect(signal?.aborted).toBe(true);
        expect(signal?.reason).toBeInstanceOf(CommandCancelledError);
    });

    it('reports exhaustion only once when retries fail without fallback', async () => {
        const circuitBreaker = createCircuitBreakerStub();
        const hooks = {
            onError: vi.fn(),
        };

        const command = new Command(
            () => {
                throw new Error('nope');
            },
            {
                maxAttempts: 2,
                circuitBreaker: circuitBreaker as never,
                hooks,
            },
        );

        await expect(command.run()).rejects.toThrow('nope');
        expect(circuitBreaker.failure).toHaveBeenCalledTimes(1);
        expect(hooks.onError).toHaveBeenCalledTimes(1);
    });

    it('rejects immediately when cancelled or blocked by preconditions', async () => {
        const cancelled = new Command(() => 'never');
        cancelled.cancel();

        await expect(cancelled.run()).rejects.toBeInstanceOf(CommandCancelledError);

        const circuitBlocked = new Command(() => 'never', {
            circuitBreaker: createCircuitBreakerStub(false) as never,
        });
        await expect(circuitBlocked.run()).rejects.toBeInstanceOf(
            CircuitBreakerOpenError,
        );

        const rateBlocked = new Command(() => 'never', {
            rateLimiter: createRateLimiterStub(false) as never,
        });
        await expect(rateBlocked.run()).rejects.toBeInstanceOf(
            RateLimitExceededError,
        );

        const nullBlocked = new Command(() => undefined, {
            errorOnNull: true,
        });
        await expect(nullBlocked.run()).rejects.toBeInstanceOf(NullValueError);
    });

    it('allows void suppliers when null enforcement is disabled', async () => {
        const command = new Command<void>(
            () => undefined,
            {
                errorOnNull: false,
            },
        );

        await expect(command.run()).resolves.toBeUndefined();
    });
});

function createCircuitBreakerStub(allow = true) {
    return {
        allow: vi.fn(() => allow),
        success: vi.fn(),
        failure: vi.fn(),
    };
}

function createRateLimiterStub(allow = true) {
    return {
        allow: vi.fn(() => allow),
    };
}
