import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { computeRtcTopologyEntry } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createComputedRtcTopologyOutbox } from '../rtc-topology-test-fixtures.ts';

const repository = vi.hoisted(() => ({
    writeIfAbsentOrMatch: vi.fn<(entry: ResourceEntry) => Promise<void>>()
}));

vi.mock(
    '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts',
    () => ({
        PSqlResourceInboxEntryRepository: class {
            writeIfAbsentOrMatch = repository.writeIfAbsentOrMatch;
        }
    })
);

describe('RTC topology outbox writer', () => {
    beforeEach(() => {
        repository.writeIfAbsentOrMatch.mockReset();
        repository.writeIfAbsentOrMatch.mockResolvedValue();
    });

    it('keeps write observers isolated to their constructed owner', async () => {
        const firstObserver = vi.fn();
        const secondObserver = vi.fn();
        const firstWriter = new RtcTopologyOutboxWriter({ recordWrite: firstObserver });
        const secondWriter = new RtcTopologyOutboxWriter({ recordWrite: secondObserver });
        const transaction = createUnusedTransaction();

        await firstWriter.write(transaction, createComputedRtcTopologyOutbox());
        await secondWriter.write(transaction, createComputedRtcTopologyOutbox());

        expect(firstObserver).toHaveBeenCalledTimes(1);
        expect(secondObserver).toHaveBeenCalledTimes(1);
        expect(repository.writeIfAbsentOrMatch).toHaveBeenCalledTimes(2);
    });

    it('returns the durable entry when its observer fails', async () => {
        const writer = new RtcTopologyOutboxWriter({
            recordWrite: () => {
                throw new Error('observer failed');
            }
        });
        const computed = createComputedRtcTopologyOutbox();

        const entry = await writer.write(createUnusedTransaction(), computed);

        expect(repository.writeIfAbsentOrMatch).toHaveBeenCalledWith(entry);
        expect(entry).toEqual(computeRtcTopologyEntry(computed));
    });
});

function createUnusedTransaction(): PSqlSql {
    function sql<Result>(
        _strings: TemplateStringsArray,
        ..._values: readonly PSqlParameter[]
    ): Promise<Result>;
    function sql(_values: readonly PSqlParameter[]): object;
    function sql(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]
    ): Promise<never> | object {
        return Array.isArray(stringsOrValues) && !Object.hasOwn(stringsOrValues, 'raw')
            ? {}
            : Promise.reject(new Error('The mocked repository must not execute SQL'));
    }
    return Object.assign(sql, {
        begin: async <T>(_write: (transaction: PSqlSql) => Promise<T>): Promise<T> =>
            await Promise.reject(new Error('The mocked repository must not open a transaction'))
    });
}
