import { afterEach, describe, expect, it, vi } from 'vitest';

import { initResourceInboxExpiryEviction } from '@shared-server/queuebox/postgres/resource-inbox-maintenance.ts';

describe('Resource inbox expiry eviction', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('evicts expired entries and expired results immediately and then on the configured interval', async () => {
        vi.useFakeTimers();
        const evictions: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        await initResourceInboxExpiryEviction({
            entries: {
                deleteExpired: async () => {
                    evictions.push('entries');
                    return 2;
                }
            },
            results: {
                deleteExpired: async () => {
                    evictions.push('results');
                    return 3;
                }
            }
        }, 1_000);
        expect(evictions).toEqual(['entries', 'results']);
        expect(log).toHaveBeenCalledWith('Evicted expired resource_inbox rows: 2');
        expect(log).toHaveBeenCalledWith('Evicted expired resource_inbox_results rows: 3');

        await vi.advanceTimersByTimeAsync(1_000);
        expect(evictions).toEqual(['entries', 'results', 'entries', 'results']);
    });
});
