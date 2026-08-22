import { Temporal } from '@js-temporal/polyfill';
import { PSqlAdminPruneExpiredRepository } from '@shared-server/postgres/admin-operations/PSqlAdminPruneExpiredRepository.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
    advanceAdminPruneAggregate,
    createAdminPruneAggregate,
    toAdminPruneAggregateEntry,
    toAdminPruneAggregateKey
} from '@shared-server/rallar-system/admin-operations/admin-prune-progress.ts';
import type { AdminPrunePageWork } from '@shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts';
import assert from 'node:assert/strict';
import { createResourceEntry, readPGliteDatabaseEpochMs, withPGliteSql } from './pglite-auth-test-harness.ts';

Deno.test('admin prune PSQL repository reads and deletes one deterministic page', async () => {
    await withPGliteSql(async (sql) => {
        const now = await readPGliteDatabaseEpochMs(sql);
        for (const key of ['1', '2', '3']) {
            await sql`
        insert into runtime_state_store (
          store_namespace, store_key, store_value, expire_at_ts, revision
        ) values ('test', ${key}, '{}', ${new Date(now - 1_000)}, 1)
      `;
        }
        await sql`
      insert into runtime_state_store (
        store_namespace, store_key, store_value, expire_at_ts, revision
      ) values ('test', 'future', '{}', ${new Date(now + 60_000)}, 1)
    `;
        const repository = new PSqlAdminPruneExpiredRepository(sql, 'server-1');
        const read = await repository.readPage({
            category: 'runtime-state',
            pageSize: 2,
            afterCursor: null,
            expireAtEpochMs: now,
            appData: null,
            excludedResourceId: null
        });
        assert.equal(read.rowIds.length, 2);
        assert.equal(read.hasMore, true);

        const work: AdminPrunePageWork = {
            kind: 'page',
            jobId: 'job-1',
            category: 'runtime-state',
            requestedBy: 'admin',
            requestedSessionId: 'session-1',
            capturedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        };
        await sql.begin(async (transaction) => {
            assert.equal(await repository.deletePage(transaction, work, read.rowIds), 2);
        });
        const [remaining] = await sql<{ count: string | number; }[]>`
      select count(*) as count from runtime_state_store where expire_at_ts <= ${new Date(now)}
    `;
        assert.equal(Number(remaining?.count), 1);
    });
});

Deno.test('admin prune PSQL repository excludes its executing resource row', async () => {
    await withPGliteSql(async (sql) => {
        const now = await readPGliteDatabaseEpochMs(sql);
        const inbox = new ResourceInboxRepository(sql);
        const expiryTs = Temporal.Instant.fromEpochMilliseconds(now - 1);
        await inbox.write(createResourceEntry('executing', { expiryTs }));
        await inbox.write(createResourceEntry('other', { expiryTs }));
        const repository = new PSqlAdminPruneExpiredRepository(sql, 'server-1');
        const read = await repository.readPage({
            category: 'resource-inbox',
            pageSize: 10,
            afterCursor: null,
            expireAtEpochMs: now,
            appData: null,
            excludedResourceId: 'executing'
        });
        assert.equal(read.rowIds.length, 1);
        const rows = await sql<{ ri_resource_id: string; }[]>`
      select ri_resource_id from resource_inbox where ri_row_id = ${Number(read.rowIds[0])}
    `;
        assert.deepEqual(rows.map((row) => row.ri_resource_id), ['other']);
    });
});

Deno.test('admin prune PSQL progress CAS completes the aggregate result', async () => {
    await withPGliteSql(async (sql) => {
        const now = await readPGliteDatabaseEpochMs(sql);
        const aggregate = createAdminPruneAggregate({
            jobId: 'job-aggregate',
            generatedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
            serverId: 'server-1',
            requestedBy: 'admin',
            requestedSessionId: 'session-1',
            categories: ['runtime-state'],
            expiredRows: { 'runtime-state': 2 }
        });
        const aggregateEntry = toAdminPruneAggregateEntry(aggregate);
        await new ResourceInboxResultsRepository(sql).replace(aggregateEntry);

        const repository = new PSqlAdminPruneExpiredRepository(sql, 'server-1');
        await sql.begin(async (transaction) => {
            const page = {
                kind: 'page',
                jobId: 'job-aggregate',
                category: 'runtime-state',
                rowIds: ['1', '2'],
                deletedRows: 2,
                next: null
            } as const;
            await repository.writeProgress(transaction, {
                ...page,
                expectedAggregate: aggregateEntry.resource,
                aggregateSuccessor: toAdminPruneAggregateEntry(
                    advanceAdminPruneAggregate(aggregate, page)
                ),
                finishedAtEpochMs: now
            });
        });

        const result = await new ResourceInboxResultsRepository(sql).findAnyByKey(
            toAdminPruneAggregateKey('job-aggregate')
        );
        assert.equal(result?.status, 'COMPLETED');
        assert.deepEqual(JSON.parse(result?.resource ?? '{}').results, [{
            category: 'runtime-state',
            expiredRows: 2,
            deletedRows: 2,
            dryRun: false
        }]);
    });
});
