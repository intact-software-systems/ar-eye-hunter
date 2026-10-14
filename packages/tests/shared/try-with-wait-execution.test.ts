import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { TryWithExhaustedError, TryWithPolicy } from '@shared/resilience/try-with-policy.ts';

afterEach(() => vi.useRealTimers());
describe('Canonical retry wait execution', () => {
    it('samples once after each accepted predicate and preserves explicit jitter arithmetic', async () => {
        const events: string[] = [];
        const samples = [0.25, 0.75];
        const policy = TryWithPolicy.defaults({
            nowEpochMs: () => 0,
            randomUnit: () => {
                events.push('sample');
                return samples.shift() ?? 0.5;
            },
            wait: async () => {
                throw new Error('Custom retry wait must own execution');
            }
        })
            .maxAttempts(3).retryIntervalMsecs(10).jitterRatio(0.2)
            .retryIf((_error, context) => {
                events.push(`predicate:${context.attempt}`);
                return true;
            })
            .onRetry((context) => {
                events.push(`observer:${context.delayMsecs}`);
            })
            .waitBeforeRetry(async (context) => {
                events.push(`wait:${context.delayMsecs}`);
            });
        await expect(policy.run(() => {
            throw new Error('retry');
        })).rejects.toBeInstanceOf(TryWithExhaustedError);
        expect(events).toEqual(['predicate:1', 'sample', 'observer:9', 'wait:9', 'predicate:2', 'sample', 'observer:22', 'wait:22']);
    });

    it('keeps predicate, backoff, observer ordering and attempt budget with custom wait execution', async () => {
        let attempts = 0;
        const events: string[] = [];
        const policy = TryWithPolicy.defaults().maxAttempts(3).retryIntervalMsecs(10).jitterRatio(0)
            .retryIf((_error, context) => {
                events.push(`predicate:${context.attempt}`);
                return true;
            })
            .onRetry((context) => {
                events.push(`observer:${context.delayMsecs}`);
            })
            .waitBeforeRetry(async (context) => {
                events.push(`wait:${context.delayMsecs}`);
            });
        await expect(policy.run(() => {
            attempts += 1;
            throw new Error('retry');
        })).rejects.toBeInstanceOf(TryWithExhaustedError);
        expect(attempts).toBe(3);
        expect(events).toEqual(['predicate:1', 'observer:10', 'wait:10', 'predicate:2', 'observer:20', 'wait:20']);
    });

    it('refuses an over-budget scheduled delay before custom wait execution', async () => {
        let waits = 0;
        const policy = TryWithPolicy.defaults().retryIntervalMsecs(100).jitterRatio(0).maxElapsedMsecs(99)
            .waitBeforeRetry(async () => {
                waits += 1;
            });
        await expect(policy.run(() => {
            throw new Error('retry');
        })).rejects.toBeInstanceOf(TryWithExhaustedError);
        expect(waits).toBe(0);
    });

    it.each(['observer', 'wait'] as const)('propagates %s exception without another attempt or background timer', async (failedPort) => {
        vi.useFakeTimers();
        const error = new Error('port failed');
        let attempts = 0;
        const policy = TryWithPolicy.defaults().retryIntervalMsecs(1000)
            .onRetry(() => {
                if (failedPort === 'observer') {
                    throw error;
                }
            })
            .waitBeforeRetry(async () => {
                throw error;
            });
        await expect(policy.run(() => {
            attempts += 1;
            throw new Error('retry');
        })).rejects.toBe(error);
        expect(attempts).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});
