import { describe, expect, it, vi } from 'vitest';
import { evictExpiredRuntimeStateRows } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';

describe('runtime state expiry eviction', () => {
    it('deletes expired rows across all runtime_state_store namespaces', async () => {
        const repository = {
            deleteAllExpired: vi.fn(async () => 2),
        };
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await expect(evictExpiredRuntimeStateRows(repository)).resolves.toBe(2);

        expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('Evicted expired runtime_state_store rows: 2');
        log.mockRestore();
    });

    it('stays quiet when there is nothing to evict', async () => {
        const repository = {
            deleteAllExpired: vi.fn(async () => 0),
        };
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await expect(evictExpiredRuntimeStateRows(repository)).resolves.toBe(0);

        expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
        expect(log).not.toHaveBeenCalled();
        log.mockRestore();
    });
});
