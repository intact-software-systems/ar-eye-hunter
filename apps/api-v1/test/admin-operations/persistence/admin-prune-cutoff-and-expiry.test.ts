import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import { PSqlAdminOperationsPruner } from '@shared-server/postgres/admin-operations/\
PSqlAdminOperationsStatsReader.ts';

import { PSqlAdminPruneRepository } from '@shared-server/postgres/admin-operations/\
p-sql-admin-prune-repository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/\
ResourceInboxResultsRepository.ts';
import { createAdminPruneAggregate, toAdminPruneAggregateEntry } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-progress.ts';

import { queueNow } from '../../crdt/crdt-api-test-fixtures.ts';
import { createResourceEntry, readPGliteDatabaseEpochMs, withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

Deno.test(
    'initial prune statistics use the command capture cutoff instead of database now',
    async () => {
        await withPGliteSql(async (sql) => {
            const databaseNow = await readPGliteDatabaseEpochMs(sql);
            await new ResourceInboxResultsRepository(sql).writeIfAbsentOrReplaceExpired(
                createResourceEntry('resource-1', {
                    topicId: 'topic-1',
                    contextId: 'context-1',
                    expiryTs: Temporal.Instant.fromEpochMilliseconds(databaseNow - 1_000)
                })
            );
            const pruner = new PSqlAdminOperationsPruner(sql);

            assert.equal(
                await pruner.countExpired('resource-inbox-results', {
                    cutoffEpochMs: databaseNow - 10_000
                }),
                0
            );
        });
    }
);

Deno.test('prune progress renews physical and JSON aggregate expiry together', async () => {
    await withPGliteSql(async (sql) => {
        const now = await queueNow(sql);
        const current = createAdminPruneAggregate({
            jobId: 'prune-physical-expiry',
            generatedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
            serverId: 'server-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            categories: ['runtime-state'],
            expiredRows: { 'runtime-state': 1 }
        });
        const currentEntry = toAdminPruneAggregateEntry(current);
        await new ResourceInboxResultsRepository(sql).writeIfAbsentOrReplaceExpired(currentEntry);
        const renewed = {
            ...current,
            revision: 1,
            expireAtEpochMs: now + 120_000
        };
        const successor = toAdminPruneAggregateEntry(renewed);
        await sql.begin(async (transaction) => {
            await new PSqlAdminPruneRepository(sql).writeProgress(transaction, {
                kind: 'page',
                jobId: current.jobId,
                category: 'runtime-state',
                rowIds: [],
                deletedRows: 0,
                next: null,
                expectedAggregate: currentEntry.resource,
                aggregateSuccessor: successor,
                finishedAtEpochMs: now + 1
            });
        });
        const [stored] = await sql<{ ris_resource: string; expire_epoch_ms: string | number; }[]>`
      select ris_resource, floor(extract(epoch from expire_ts) * 1000)::bigint as expire_epoch_ms
      from resource_inbox_results
      where ris_topic_id = ${successor.key.topicId}
        and ris_resource_id = ${successor.key.resourceId}
        and fk_ext_bank_id = ${successor.key.contextId}
    `;

        assert.equal(JSON.parse(stored!.ris_resource).expireAtEpochMs, renewed.expireAtEpochMs);
        assert.equal(Number(stored!.expire_epoch_ms), renewed.expireAtEpochMs);
    });
});
