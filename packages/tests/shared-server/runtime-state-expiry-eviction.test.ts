import { describe, expect, it, vi } from 'vitest';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
    evictExpiredRuntimeStateRows,
    initRuntimeStateExpiryEviction,
    PSqlRuntimeStateRepository,
} from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';

describe('runtime state expiry eviction', () => {
    it('deletes expired rows across all runtime_state_store namespaces', async () => {
        const repository = {
            deleteAllExpired: vi.fn(async () => 2),
        };
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await expect(evictExpiredRuntimeStateRows(repository)).resolves.toBe(2);

            expect(repository.deleteAllExpired).toHaveBeenCalledWith([]);
            expect(log).toHaveBeenCalledWith('Evicted expired runtime_state_store rows: 2');
        } finally {
            log.mockRestore();
        }
    });

    it('passes caller-owned protected namespaces to generic expiry eviction', async () => {
        const repository = {
            deleteAllExpired: vi.fn(async () => 0),
        };
        const protectedNamespaces = [
            'rtc-rtt:receipts',
            'rtc-rtt:recompute-outbox',
        ];

        await expect(evictExpiredRuntimeStateRows(repository, {
            excludedNamespaces: protectedNamespaces,
        })).resolves.toBe(0);

        expect(repository.deleteAllExpired).toHaveBeenCalledWith(protectedNamespaces);
    });

    it('emits safe empty and nonempty generic namespace exclusion SQL', async () => {
        const captured = captureExpiryQueries();
        const repository = new PSqlRuntimeStateRepository(captured.sql);

        await repository.deleteAllExpired([]);
        await repository.deleteAllExpired([
            'rtc-rtt:receipts',
            'rtc-rtt:recompute-outbox',
        ]);

        expect(captured.queries).toHaveLength(2);
        expect(captured.queries[0]!.text).not.toContain('store_namespace not in');
        expect(captured.queries[1]!.text).toContain('store_namespace not in');
        expect(captured.queries[1]!.values).toContainEqual({
            kind: 'array',
            values: ['rtc-rtt:receipts', 'rtc-rtt:recompute-outbox'],
        });
    });

    it('stays quiet when there is nothing to evict', async () => {
        const repository = {
            deleteAllExpired: vi.fn(async () => 0),
        };
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await expect(evictExpiredRuntimeStateRows(repository)).resolves.toBe(0);

            expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
            expect(log).not.toHaveBeenCalled();
        } finally {
            log.mockRestore();
        }
    });

    it.each([
        {
            label: 'legacy numeric interval',
            input: 123,
            intervalMs: 123,
            excludedNamespaces: [],
        },
        {
            label: 'default interval',
            input: undefined,
            intervalMs: 60_000,
            excludedNamespaces: [],
        },
        {
            label: 'options interval and exclusions',
            input: {
                intervalMs: 456,
                excludedNamespaces: ['rtc-rtt:receipts'],
            },
            intervalMs: 456,
            excludedNamespaces: ['rtc-rtt:receipts'],
        },
    ] as const)('preserves $label expiry initializer behavior', async ({
        input,
        intervalMs,
        excludedNamespaces,
    }) => {
        vi.useFakeTimers();
        const repository = {
            deleteAllExpired: vi.fn(async () => 0),
        };
        try {
            const initialised = input === undefined
                ? initRuntimeStateExpiryEviction(repository)
                : initRuntimeStateExpiryEviction(repository, input);
            await initialised.firstRun;
            expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
            expect(repository.deleteAllExpired)
                .toHaveBeenLastCalledWith([...excludedNamespaces]);

            await vi.advanceTimersByTimeAsync(intervalMs - 1);
            expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(repository.deleteAllExpired).toHaveBeenCalledTimes(2);
            initialised.stop();
            initialised.stop();
            await vi.advanceTimersByTimeAsync(intervalMs * 2);
            expect(repository.deleteAllExpired).toHaveBeenCalledTimes(2);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('does not reschedule generic expiry after stop during an in-flight run', async () => {
        let release!: (removed: number) => void;
        const blocked = new Promise<number>((resolve) => release = resolve);
        const repository = {
            deleteAllExpired: vi.fn(() => blocked),
        };
        const scheduled: Array<Readonly<{
            callback: () => void | Promise<void>;
            delayMs: number;
        }>> = [];
        const handle = initRuntimeStateExpiryEviction(repository, {
            intervalMs: 100,
            schedule: (callback, delayMs) => {
                scheduled.push({ callback, delayMs });
                return {};
            },
            cancel: () => {},
        });

        expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
        handle.stop();
        handle.stop();
        release(0);
        await handle.firstRun;

        expect(scheduled).toEqual([]);
    });
});

function captureExpiryQueries(): Readonly<{
    sql: PSqlSql;
    queries: Array<Readonly<{ text: string; values: readonly unknown[] }>>;
}> {
    const queries: Array<Readonly<{ text: string; values: readonly unknown[] }>> = [];
    const sql = ((
        stringsOrValues: TemplateStringsArray | readonly unknown[],
        ...values: unknown[]
    ): Promise<readonly unknown[]> | Readonly<{
        kind: 'array';
        values: readonly unknown[];
    }> => {
        if (!Object.prototype.hasOwnProperty.call(stringsOrValues, 'raw')) {
            return { kind: 'array', values: stringsOrValues };
        }
        queries.push({
            text: Array.from(stringsOrValues).join('?').replaceAll(/\s+/g, ' ').trim(),
            values,
        });
        return Promise.resolve([]);
    }) as PSqlSql;
    sql.begin = async <T>(fn: (transaction: PSqlSql) => Promise<T>) => await fn(sql);
    return { sql, queries };
}
