import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { assertRuntimeStateReadBatchResult } from '@shared-server/runtime-state/read-batch/assert-runtime-state-read-batch-result.ts';
import { resolveRuntimeStateReadBatchLiveValues } from '@shared-server/runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import type { RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRuntimeStateRepository } from '../test-support/fake-runtime-state-repository.ts';

vi.mock('@shared-server/runtime-state/read-batch/assert-runtime-state-read-batch-result.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('@shared-server/runtime-state/read-batch/assert-runtime-state-read-batch-result.ts')>();
    return { assertRuntimeStateReadBatchResult: vi.fn(original.assertRuntimeStateReadBatchResult) };
});

const KEY = 'app=app:ws=workspace:group=room';

const SELECTORS = [{
    selectorId: 'group',
    kind: 'key',
    namespace: 'group-state:groups',
    key: KEY
}, {
    selectorId: 'members',
    kind: 'prefix',
    namespace: 'group-state:members',
    keyPrefix: `${KEY}:`
}] as const satisfies readonly RuntimeStateReadBatchSelector[];

describe('runtime-state read batch validation', () => {
    it('validates a read once, at the repository, and resolves its live values without validating again', async () => {
        const repository = new PSqlRuntimeStateRepository(rowsSql([
            toDriverRow(1, KEY),
            toDriverRow(2, `${KEY}:member=alice`)
        ]));
        vi.mocked(assertRuntimeStateReadBatchResult).mockClear();

        const resolved = await resolveRuntimeStateReadBatchLiveValues(
            SELECTORS,
            await repository.readRuntimeStateBatch(SELECTORS),
            async (_namespace, entry) => ({ entry, value: JSON.parse(entry.value) })
        );

        expect(resolved.status).toBe('stable');
        expect(assertRuntimeStateReadBatchResult).toHaveBeenCalledTimes(1);
    });

    it('lets the topology mutation read trust its store\'s validated batch', async () => {
        const repository = new GroupTopologyConfigRepository(new FakeRuntimeStateRepository());
        vi.mocked(assertRuntimeStateReadBatchResult).mockClear();

        const read = await repository.readMutationExactEntries(
            { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
            'request-1'
        );

        expect(read.status).toBe('stable');
        expect(assertRuntimeStateReadBatchResult).toHaveBeenCalledTimes(1);
    });
});

function toDriverRow(selectorOrdinal: number, key: string): PSqlRows[number] {
    return {
        selector_ordinal: selectorOrdinal,
        store_key: key,
        store_value: '{}',
        expire_at_timestamp: String(Date.parse('9999-12-31T23:59:59.999Z')),
        updated_timestamp: '2026-07-21T00:00:00.000Z',
        revision: '0',
        row_version: '1/(0,1)'
    };
}

function rowsSql(rows: PSqlRows): PSqlSql {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]): Promise<Result> | object {
        return Object.hasOwn(stringsOrValues, 'raw') ? Promise.resolve(rows as Result) : {};
    }
    return Object.assign(sql, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => await write(rowsSql(rows))
    });
}
