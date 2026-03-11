import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../apps/api-v1/src/db/db.ts', () => ({
    sql: {},
}));

describe('Resource inbox expiry eviction', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('runs deleteExpired immediately and then on the configured interval', async () => {
        vi.useFakeTimers();
        const repo = {
            deleteExpired: vi.fn(async () => 2),
        };
        const log = vi.spyOn(console, 'log').mockImplementation(() => {
        });
        const { initResourceInboxExpiryEviction } = await import(
            '../../../apps/api-v1/src/repository/ResourceInboxRepository.ts'
            );

        await initResourceInboxExpiryEviction(repo as never, 1_000);
        expect(repo.deleteExpired).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('Evicted expired resource_inbox rows: 2');

        await vi.advanceTimersByTimeAsync(1_000);
        expect(repo.deleteExpired).toHaveBeenCalledTimes(2);
    });
});
