import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { computeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { computeRtcTopologyEntry } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { describe, expect, it, vi } from 'vitest';

import { createComputedRtcTopologyOutbox } from '../rtc-topology-test-fixtures.ts';

describe('RTC topology outbox writer', () => {
    it('records committed writes only when the transaction owner reports success', async () => {
        const recordedWrites: string[] = [];
        const firstWriter = new RtcTopologyOutboxWriter({
            recordWrite: () => recordedWrites.push('first')
        });
        const secondWriter = new RtcTopologyOutboxWriter({
            recordWrite: () => recordedWrites.push('second')
        });
        const transaction = createInsertTransaction();
        const computed = computeAppOutboxInsert(
            computeRtcTopologyEntry(createComputedRtcTopologyOutbox())
        );

        await firstWriter.write(transaction, computed);
        expect(recordedWrites).toEqual([]);
        firstWriter.recordCommittedWrites(1);
        secondWriter.recordCommittedWrites(2);

        expect(recordedWrites).toEqual(['first', 'second', 'second']);
    });

    it('keeps observer failures outside durable write behavior', () => {
        const writer = new RtcTopologyOutboxWriter({
            recordWrite: () => {
                throw new Error('observer failed');
            }
        });

        expect(() => writer.recordCommittedWrites(1)).not.toThrow();
    });
});

function createInsertTransaction(): PSqlSql {
    function sql<Result>(
        _strings: TemplateStringsArray,
        ..._values: readonly PSqlParameter[]
    ): Promise<Result>;
    function sql(_values: readonly PSqlParameter[]): object;
    function sql(stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]) {
        return Array.isArray(stringsOrValues) && !Object.hasOwn(stringsOrValues, 'raw')
            ? {}
            : Promise.resolve([{ ri_row_id: 1n }]);
    }
    return Object.assign(sql, {
        begin: async <T>(_write: (transaction: PSqlSql) => Promise<T>): Promise<T> => await Promise.reject(new Error('The writer must not open a transaction'))
    });
}
