import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { evictExpiredRuntimeStateRows, RuntimeStateExpiryWorker } from '@shared-server/runtime-state/postgres/runtime-state-expiry-worker.ts';
import { describe, expect, it, vi } from 'vitest';

describe('runtime state expiry eviction', () => {
    it('deletes expired rows across all runtime_state_store namespaces', async () => {
        const repository = {
            deleteAllExpired: vi.fn(async () => 2)
        };
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await expect(evictExpiredRuntimeStateRows({ repository })).resolves.toBe(2);

            expect(repository.deleteAllExpired).toHaveBeenCalledWith([]);
            expect(log).toHaveBeenCalledWith('Evicted expired runtime_state_store rows: 2');
        }
        finally {
            log.mockRestore();
        }
    });

    it('passes caller-owned protected namespaces to generic expiry eviction', async () => {
        const repository = {
            deleteAllExpired: vi.fn(async () => 0)
        };
        const protectedNamespaces = ['rtc-rtt:receipts', 'test:second-protected-family'];

        await expect(
            evictExpiredRuntimeStateRows({
                repository,
                excludedNamespaces: protectedNamespaces
            })
        ).resolves.toBe(0);

        expect(repository.deleteAllExpired).toHaveBeenCalledWith(protectedNamespaces);
    });

    it('emits safe empty and nonempty generic namespace exclusion SQL', async () => {
        const captured = captureExpiryQueries();
        const repository = new PSqlRuntimeStateRepository(captured.sql);

        await repository.deleteAllExpired([]);
        await repository.deleteAllExpired(['rtc-rtt:receipts', 'test:second-protected-family']);

        expect(captured.queries).toHaveLength(2);
        expect(captured.queries[0]!.text).not.toContain('store_namespace not in');
        expect(captured.queries[1]!.text).toContain('store_namespace not in');
        expect(captured.queries[1]!.values).toContainEqual({
            kind: 'array',
            values: ['rtc-rtt:receipts', 'test:second-protected-family']
        });
    });

    it('stays quiet when there is nothing to evict', async () => {
        const repository = {
            deleteAllExpired: vi.fn(async () => 0)
        };
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await expect(evictExpiredRuntimeStateRows({ repository })).resolves.toBe(0);

            expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
            expect(log).not.toHaveBeenCalled();
        }
        finally {
            log.mockRestore();
        }
    });

    it.each(
        [
            {
                label: 'default interval',
                options: {},
                intervalMs: 60_000,
                excludedNamespaces: []
            },
            {
                label: 'configured interval and exclusions',
                options: {
                    intervalMs: 456,
                    excludedNamespaces: ['rtc-rtt:receipts']
                },
                intervalMs: 456,
                excludedNamespaces: ['rtc-rtt:receipts']
            }
        ] as const
    )(
        'runs immediately and schedules the $label until stopped',
        async ({ options, intervalMs, excludedNamespaces }) => {
            vi.useFakeTimers();
            const repository = {
                deleteAllExpired: vi.fn(async () => 0)
            };
            try {
                const worker = new RuntimeStateExpiryWorker({
                    repository,
                    ...options
                });
                await worker.firstRun;
                expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
                expect(repository.deleteAllExpired).toHaveBeenLastCalledWith([...excludedNamespaces]);

                await vi.advanceTimersByTimeAsync(intervalMs - 1);
                expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(1);
                expect(repository.deleteAllExpired).toHaveBeenCalledTimes(2);
                worker.stop();
                worker.stop();
                await vi.advanceTimersByTimeAsync(intervalMs * 2);
                expect(repository.deleteAllExpired).toHaveBeenCalledTimes(2);
            }
            finally {
                vi.clearAllTimers();
                vi.useRealTimers();
            }
        }
    );

    it('does not reschedule generic expiry after stop during an in-flight run', async () => {
        const blocked = createDeferred<number>();
        const repository = {
            deleteAllExpired: vi.fn(() => blocked.promise)
        };
        const scheduled: Array<
            Readonly<{
                callback: () => void | Promise<void>;
                delayMs: number;
            }>
        > = [];
        const worker = new RuntimeStateExpiryWorker({
            repository,
            intervalMs: 100,
            schedule: (callback, delayMs) => {
                scheduled.push({ callback, delayMs });
                return { cancel: () => undefined };
            }
        });

        expect(repository.deleteAllExpired).toHaveBeenCalledTimes(1);
        worker.stop();
        worker.stop();
        blocked.resolve(0);
        await worker.firstRun;

        expect(scheduled).toEqual([]);
    });
});

function captureExpiryQueries(): Readonly<{
    sql: PSqlSql;
    queries: Array<Readonly<{ text: string; values: readonly PSqlParameter[]; }>>;
}> {
    const queries: Array<Readonly<{ text: string; values: readonly PSqlParameter[]; }>> = [];
    const sql = ((
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: PSqlParameter[]
    ):
        | Promise<PSqlRows>
        | Readonly<{
            kind: 'array';
            values: readonly PSqlParameter[];
        }> => {
        if (!Object.prototype.hasOwnProperty.call(stringsOrValues, 'raw')) {
            return { kind: 'array', values: stringsOrValues };
        }
        queries.push({
            text: Array.from(stringsOrValues).join('?').replaceAll(/\s+/g, ' ').trim(),
            values
        });
        return Promise.resolve([]);
    }) as PSqlSql;
    sql.begin = async <T>(fn: (transaction: PSqlSql) => Promise<T>) => await fn(sql);
    return { sql, queries };
}

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve(value) {
            if (resolvePromise === undefined) {
                throw new Error('Deferred test result is unavailable');
            }
            resolvePromise(value);
        }
    };
}
