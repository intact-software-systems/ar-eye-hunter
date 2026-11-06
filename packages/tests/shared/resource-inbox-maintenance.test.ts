import { startResourceInboxExpiryEviction } from '@shared-server/queuebox/postgres/resource-inbox-maintenance.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('resource inbox expiry lifecycle', () => {
    it('evicts both owned tables immediately and periodically, then stops', async () => {
        vi.useFakeTimers();
        const evictions: string[] = [];
        const stop = startResourceInboxExpiryEviction({
            entries: {
                deleteExpired: async () => {
                    evictions.push('entries');
                    return 0;
                }
            },
            results: {
                deleteExpired: async () => {
                    evictions.push('results');
                    return 0;
                }
            },
            timers: createDefaultTimers(),
            intervalMs: 1000,
            onFailure: (error) => {
                throw error;
            }
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(evictions).toEqual(['entries', 'results']);
        await vi.advanceTimersByTimeAsync(1000);
        expect(evictions).toEqual(['entries', 'results', 'entries', 'results']);
        await stop();
        await vi.advanceTimersByTimeAsync(10000);
        expect(evictions).toHaveLength(4);
    });

    it('drains the current database operation before shutdown resolves', async () => {
        vi.useFakeTimers();
        const held = Promise.withResolvers<number>();
        const results = vi.fn(async () => 0);
        const stop = startResourceInboxExpiryEviction({
            entries: { deleteExpired: () => held.promise },
            results: { deleteExpired: results },
            timers: createDefaultTimers(),
            intervalMs: 1000,
            onFailure: (error) => {
                throw error;
            }
        });
        let stopped = false;
        const stopping = stop().then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        held.resolve(0);
        await stopping;
        await stop();
        await vi.advanceTimersByTimeAsync(10000);
        expect(results).toHaveBeenCalledTimes(1);
        expect(stopped).toBe(true);
    });
});
