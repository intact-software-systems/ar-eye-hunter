import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncCommand } from '@shared/cache/AsyncCommand.ts';
import {
    CircuitBreakerOpenError,
    Command,
    CommandCancelledError,
    CommandTimedOutError,
    NullValueError,
    RateLimitExceededError,
} from '@shared/cache/Command.ts';
import { PullPushCommand } from '@shared/cache/PullPushCommand.ts';

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

    it('stops retrying when shouldRetry rejects the error', async () => {
        let attempts = 0;
        const shouldRetry = vi.fn(() => false);

        const command = new Command(
            () => {
                attempts += 1;
                throw new Error('non-retryable');
            },
            {
                maxAttempts: 3,
                shouldRetry,
            },
        );

        await expect(command.run()).rejects.toThrow('non-retryable');
        expect(attempts).toBe(1);
        expect(shouldRetry).toHaveBeenCalledOnce();
    });

    it('enforces null fallback values unless null enforcement is disabled', async () => {
        await expect(
            new Command<string>(
                () => {
                    throw new Error('boom');
                },
                {
                    fallback: () => undefined as never,
                },
            ).run(),
        ).rejects.toBeInstanceOf(NullValueError);

        await expect(
            new Command<string | undefined>(
                () => {
                    throw new Error('boom');
                },
                {
                    errorOnNull: false,
                    fallback: () => undefined,
                },
            ).run(),
        ).resolves.toBeUndefined();
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

describe('PullPushCommand', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('pulls a value, pushes it, and reports both phases through hooks', async () => {
        const events: string[] = [];
        const command = new PullPushCommand(
            () => {
                events.push('pull');
                return 'peer-1';
            },
            (peerId) => {
                events.push(`push:${peerId}`);
                return `connected:${peerId}`;
            },
            {
                hooks: {
                    onSubscribe: () => events.push('subscribe'),
                    onPullSuccess: (peerId) => events.push(`pulled:${peerId}`),
                    onPushSuccess: (result, peerId) =>
                        events.push(`pushed:${peerId}:${result}`),
                    onSuccess: (result) =>
                        events.push(`success:${result.pushed}`),
                    onComplete: () => events.push('complete'),
                },
            },
        );

        await expect(command.run()).resolves.toEqual({
            pulled: 'peer-1',
            pushed: 'connected:peer-1',
        });
        expect(events).toEqual([
            'subscribe',
            'pull',
            'pulled:peer-1',
            'push:peer-1',
            'pushed:peer-1:connected:peer-1',
            'success:connected:peer-1',
            'complete',
        ]);
    });

    it('exposes the pulled value to timeout cleanup hooks when push stalls', async () => {
        vi.useFakeTimers();
        let pushSignal: AbortSignal | undefined;
        const cleanup = vi.fn();
        const command = new PullPushCommand(
            () => ({
                peerId: 'peer-1',
            }),
            (_peer, signal) => {
                pushSignal = signal;
                return new Promise<void>((_resolve, reject) => {
                    signal?.addEventListener(
                        'abort',
                        () => reject(signal.reason),
                    );
                });
            },
            {
                timeoutMs: 10,
                hooks: {
                    onError: (error, peer) => {
                        cleanup(peer?.peerId, error);
                    },
                },
            },
        );

        const expectation = expect(command.run()).rejects.toBeInstanceOf(
            CommandTimedOutError,
        );

        await vi.advanceTimersByTimeAsync(10);
        await expectation;

        expect(pushSignal?.aborted).toBe(true);
        expect(pushSignal?.reason).toBeInstanceOf(CommandTimedOutError);
        expect(cleanup).toHaveBeenCalledWith(
            'peer-1',
            expect.any(CommandTimedOutError),
        );
    });

    it('retries the pull and push sequence and exposes the failed attempt value', async () => {
        const attempts: string[] = [];
        const attemptErrors: string[] = [];
        let count = 0;

        const command = new PullPushCommand(
            () => {
                count += 1;
                const peerId = `peer-${count}`;
                attempts.push(`pull:${peerId}`);
                return {
                    peerId,
                };
            },
            (peer) => {
                attempts.push(`push:${peer.peerId}`);
                if (peer.peerId === 'peer-1') {
                    throw new Error('first push failed');
                }

                return 'connected';
            },
            {
                maxAttempts: 2,
                hooks: {
                    onAttemptError: (error, _attempt, peer) => {
                        attemptErrors.push(
                            `${peer?.peerId}:${(error as Error).message}`,
                        );
                    },
                },
            },
        );

        await expect(command.run()).resolves.toEqual({
            pulled: {
                peerId: 'peer-2',
            },
            pushed: 'connected',
        });
        expect(attempts).toEqual([
            'pull:peer-1',
            'push:peer-1',
            'pull:peer-2',
            'push:peer-2',
        ]);
        expect(attemptErrors).toEqual(['peer-1:first push failed']);
    });

    it('does not pull when circuit breaker or rate limiter preconditions reject', async () => {
        const pull = vi.fn(() => 'peer-1');
        const push = vi.fn(() => undefined);

        await expect(
            new PullPushCommand(
                pull,
                push,
                {
                    circuitBreaker: createCircuitBreakerStub(false) as never,
                },
            ).run(),
        ).rejects.toBeInstanceOf(CircuitBreakerOpenError);

        await expect(
            new PullPushCommand(
                pull,
                push,
                {
                    rateLimiter: createRateLimiterStub(false) as never,
                },
            ).run(),
        ).rejects.toBeInstanceOf(RateLimitExceededError);

        expect(pull).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });

    it('uses fallback with the last pulled value when push fails', async () => {
        const fallback = vi.fn((_error: unknown, peer: { peerId: string } | undefined) => ({
            pulled: peer ?? {
                peerId: 'missing',
            },
            pushed: `fallback:${peer?.peerId ?? 'missing'}`,
        }));

        await expect(
            new PullPushCommand(
                () => ({
                    peerId: 'peer-1',
                }),
                () => {
                    throw new Error('push failed');
                },
                {
                    fallback,
                },
            ).run(),
        ).resolves.toEqual({
            pulled: {
                peerId: 'peer-1',
            },
            pushed: 'fallback:peer-1',
        });
        expect(fallback).toHaveBeenCalledWith(
            expect.any(Error),
            {
                peerId: 'peer-1',
            },
        );
    });

    it('can enforce non-null push results', async () => {
        await expect(
            new PullPushCommand(
                () => 'peer-1',
                () => undefined,
                {
                    errorOnNullPush: true,
                },
            ).run(),
        ).rejects.toThrow('Push returned null or undefined');
    });
});

describe('AsyncCommand', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('fires timeout for an incomplete watched resource', async () => {
        vi.useFakeTimers();
        const command = new AsyncCommand<string, { state: string }>();
        const resource = {
            state: 'connecting',
        };
        const timeouts: string[] = [];

        expect(
            command.watch({
                key: 'peer-1',
                resource,
                timeoutMs: 25,
                isComplete: (value) => value.state === 'open',
                onTimeout: (_value, event) => {
                    timeouts.push(`${event.key}:${event.timeoutMs}:${event.reason}`);
                },
            }),
        ).toBe(true);
        expect(command.has('peer-1')).toBe(true);

        await vi.advanceTimersByTimeAsync(24);
        expect(timeouts).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);

        expect(timeouts).toEqual(['peer-1:25:async-command-timeout']);
        expect(command.has('peer-1')).toBe(false);
    });

    it('cancels pending timeout when a resource completes', async () => {
        vi.useFakeTimers();
        const command = new AsyncCommand<string, { state: string }>();
        const resource = {
            state: 'connecting',
        };
        const onTimeout = vi.fn();

        command.watch({
            key: 'peer-1',
            resource,
            timeoutMs: 25,
            isComplete: (value) => value.state === 'open',
            onTimeout,
        });

        resource.state = 'open';
        expect(command.complete('peer-1')).toBe(true);

        await vi.advanceTimersByTimeAsync(25);

        expect(onTimeout).not.toHaveBeenCalled();
        expect(command.has('peer-1')).toBe(false);
    });

    it('replaces an existing watch for the same key', async () => {
        vi.useFakeTimers();
        const command = new AsyncCommand<string, { id: string; state: string }>();
        const first = {
            id: 'first',
            state: 'connecting',
        };
        const second = {
            id: 'second',
            state: 'connecting',
        };
        const timeouts: string[] = [];

        command.watch({
            key: 'peer-1',
            resource: first,
            timeoutMs: 10,
            isComplete: (value) => value.state === 'open',
            onTimeout: (value) => {
                timeouts.push(value.id);
            },
        });
        command.watch({
            key: 'peer-1',
            resource: second,
            timeoutMs: 20,
            isComplete: (value) => value.state === 'open',
            onTimeout: (value) => {
                timeouts.push(value.id);
            },
        });

        await vi.advanceTimersByTimeAsync(20);

        expect(timeouts).toEqual(['second']);
    });

    it('routes timeout handler failures to the watch error hook', async () => {
        vi.useFakeTimers();
        const command = new AsyncCommand<string, { state: string }>();
        const onError = vi.fn();

        command.watch({
            key: 'peer-1',
            resource: {
                state: 'connecting',
            },
            timeoutMs: 10,
            isComplete: (value) => value.state === 'open',
            onTimeout: () => {
                throw new Error('timeout cleanup failed');
            },
            onError,
        });

        await vi.advanceTimersByTimeAsync(10);

        expect(onError).toHaveBeenCalledWith(
            expect.any(Error),
            {
                state: 'connecting',
            },
            expect.objectContaining({
                key: 'peer-1',
                timeoutMs: 10,
            }),
        );
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
