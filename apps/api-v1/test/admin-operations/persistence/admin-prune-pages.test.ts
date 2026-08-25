import { Temporal } from '@js-temporal/polyfill';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { PSqlAdminPruneRepository } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-prune-repository.ts';
import { toAdminPruneOutbox, type AdminPrunePageWork } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import {
    advanceAdminPruneAggregate,
    createAdminPruneAggregate,
    toAdminPruneAggregateEntry,
    toAdminPruneAggregateKey
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-progress.ts';
import assert from 'node:assert/strict';
import { createResourceEntry, readPGliteDatabaseEpochMs, withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

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
        const repository = new PSqlAdminPruneRepository(sql);
        const read = await repository.readPage({
            category: 'runtime-state',
            pageSize: 2,
            afterCursor: null,
            expireAtEpochMs: now,
            appData: null,
            excludedResourceKey: null
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
        const inbox = createPSqlResourceInboxRepository(sql);
        const expiryTs = Temporal.Instant.fromEpochMilliseconds(now - 1);
        await inbox.entries.write(createResourceEntry('executing', { expiryTs }));
        await inbox.entries.write(createResourceEntry('executing', {
            topicId: 'other-topic',
            contextId: 'other-context',
            expiryTs
        }));
        await inbox.entries.write(createResourceEntry('other', { expiryTs }));
        const repository = new PSqlAdminPruneRepository(sql);
        const read = await repository.readPage({
            category: 'resource-inbox',
            pageSize: 10,
            afterCursor: null,
            expireAtEpochMs: now,
            appData: null,
            excludedResourceKey: {
                resourceId: 'executing',
                topicId: 'topic-smoke',
                contextId: 'ctx-smoke'
            }
        });
        assert.equal(read.rowIds.length, 2);
        const rows = await sql<{
            ri_resource_id: string;
            ri_topic_id: string;
            fk_ext_bank_id: string;
        }[]>`
      select ri_resource_id, ri_topic_id, fk_ext_bank_id
      from resource_inbox
      where ri_row_id in ${sql(read.rowIds.map(Number))}
      order by ri_resource_id, ri_topic_id, fk_ext_bank_id
    `;
        assert.deepEqual(rows, [
            {
                ri_resource_id: 'executing',
                ri_topic_id: 'other-topic',
                fk_ext_bank_id: 'other-context'
            },
            {
                ri_resource_id: 'other',
                ri_topic_id: 'topic-smoke',
                fk_ext_bank_id: 'ctx-smoke'
            }
        ]);
    });
});

Deno.test('admin prune successor outbox rejects an identical active identity', async () => {
    await withPGliteSql(async (sql) => {
        const now = await readPGliteDatabaseEpochMs(sql);
        const entry = toAdminPruneOutbox(
            {
                kind: 'page',
                jobId: 'collision-job',
                category: 'runtime-state',
                requestedBy: 'admin',
                requestedSessionId: 'session',
                capturedAtEpochMs: now,
                expireAtEpochMs: now + 60_000,
                pageSize: 100,
                afterCursor: 'cursor',
                pageIndex: 1,
                appData: null
            },
            'server-1'
        );
        await createPSqlResourceInboxRepository(sql).entries.write(entry);

        await assert.rejects(
            () =>
                sql.begin(async (transaction) => {
                    await new PSqlAdminPruneRepository(sql).writeOutbox(transaction, entry);
                }),
            Error
        );
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

        const repository = new PSqlAdminPruneRepository(sql);
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
