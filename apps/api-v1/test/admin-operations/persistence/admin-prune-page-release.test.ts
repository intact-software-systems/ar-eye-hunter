import { Temporal } from '@js-temporal/polyfill';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { PSqlAdminPruneRepository } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-prune-repository.ts';
import {
    decodeAdminPruneWork,
    toAdminPruneOutbox
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import { AdminPrunePageWorker } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-worker.ts';
import { createAdminPruneAggregate, toAdminPruneAggregateEntry } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-progress.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { ResourceInboxLostReservationError } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import assert from 'node:assert/strict';
import { readPGliteDatabaseEpochMs, withUtcPGliteSql } from '../../db/pglite-auth-test-harness.ts';

Deno.test('PSQL queue release accepts the exact admin page completed in its deletion transaction', async () => {
    await withUtcPGliteSql(async (sql) => {
        const now = await readPGliteDatabaseEpochMs(sql);
        const repository = createPSqlResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(repository);
        const entry = toAdminPruneOutbox({
            kind: 'page',
            jobId: 'atomic-prune-release',
            category: 'runtime-state',
            requestedBy: 'admin',
            requestedSessionId: 'admin-session',
            capturedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        }, 'server-1');
        await repository.entries.write(entry);
        const aggregate = toAdminPruneAggregateEntry(createAdminPruneAggregate({
            jobId: 'atomic-prune-release',
            generatedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
            serverId: 'server-1',
            requestedBy: 'admin',
            requestedSessionId: 'admin-session',
            categories: ['runtime-state'],
            expiredRows: { 'runtime-state': 1 }
        }));
        const results = new ResourceInboxResultsRepository(sql);
        await results.writeIfAbsentOrReplaceExpired(aggregate);
        await sql`insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, revision)
            values ('prune-release', 'expired', '{}', ${new Date(now - 1)}, 1)`;
        const reserved = await queue.reserveEntries(new Set([EnqueuedType.APP_OUTBOX]), new Set([EntityStatus.NEW]), {
            maxToReserve: 1,
            maxAttempts: 20
        });
        const page = [...reserved.values()][0];
        assert.ok(page);
        const worker = new AdminPrunePageWorker({
            database: sql,
            repository: new PSqlAdminPruneRepository(sql),
            serviceId: 'server-1',
            pageSize: 2,
            now: () => now,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' })
        });
        await worker.processReservedEntry(page);
        const committed = await repository.entries.findAnyByKey(page.key);
        const committedAggregate = await results.findAnyByKey(aggregate.key);
        assert.equal(committed?.status, EntityStatus.COMPLETED);
        assert.equal(committedAggregate?.status, EntityStatus.COMPLETED);

        const released = await queue.releaseEntries([page], { status: EntityStatus.COMPLETED, delayMs: null });

        assert.deepEqual([...released.values()], [committed]);
        assert.deepEqual(await repository.entries.findAnyByKey(page.key), committed);
        assert.deepEqual(await results.findAnyByKey(aggregate.key), committedAggregate);
        assert.equal(committed?.dequeueAudit.attempts, 1);
        assert.ok(committed?.dequeueAudit.endTs);
        assert.ok(Temporal.Instant.compare(committed.dequeueAudit.endTs, page.audit.expiryTs) < 0);
        const remaining = await sql<{ count: string; }[]>`
            select count(*)::text as count from runtime_state_store where store_namespace = 'prune-release'
        `;
        assert.equal(remaining[0]?.count, '0');
        const repeated = await queue.releaseEntries([page], { status: EntityStatus.COMPLETED, delayMs: null });
        assert.deepEqual([...repeated.values()], [committed]);
        const staleReservations: ResourceEntry[] = [
            { ...page, dequeueAudit: { ...page.dequeueAudit, attempts: 2 } },
            { ...page, key: { ...page.key, contextId: 'another-job' } },
            { ...page, resource: `${page.resource} ` },
            { ...page, audit: { ...page.audit, createdBy: 'another-server' } },
            { ...page, audit: { ...page.audit, expiryTs: page.audit.expiryTs.add({ seconds: 1 }) } }
        ];
        for (const stale of staleReservations) {
            await assert.rejects(
                () => queue.releaseEntries([stale], { status: EntityStatus.COMPLETED, delayMs: null }),
                ResourceInboxLostReservationError
            );
            assert.deepEqual(await repository.entries.findAnyByKey(page.key), committed);
            assert.deepEqual(await results.findAnyByKey(aggregate.key), committedAggregate);
        }
    });
});

Deno.test('admin prune conflicts and preserves runtime state replaced after the page read', async () => {
    await withUtcPGliteSql(async (sql) => {
        const now = await readPGliteDatabaseEpochMs(sql);
        const queueRepository = createPSqlResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(queueRepository);
        const entry = toAdminPruneOutbox({
            kind: 'page',
            jobId: 'stale-runtime-page',
            category: 'runtime-state',
            requestedBy: 'admin',
            requestedSessionId: 'admin-session',
            capturedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
            pageSize: 1,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        }, 'server-1');
        await queueRepository.entries.write(entry);
        const aggregateEntry = toAdminPruneAggregateEntry(createAdminPruneAggregate({
            jobId: 'stale-runtime-page',
            generatedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
            serverId: 'server-1',
            requestedBy: 'admin',
            requestedSessionId: 'admin-session',
            categories: ['runtime-state'],
            expiredRows: { 'runtime-state': 1 }
        }));
        const results = new ResourceInboxResultsRepository(sql);
        await results.writeIfAbsentOrReplaceExpired(aggregateEntry);
        await sql`
            insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, revision)
            values ('stale-runtime-page', 'same-identity', '{"version":1}', ${new Date(now - 1)}, 1)
        `;
        const reserved = (await queue.reserveEntries(
            new Set([EnqueuedType.APP_OUTBOX]),
            new Set([EntityStatus.NEW]),
            { maxToReserve: 1, maxAttempts: 20 }
        )).values().next().value;
        assert.ok(reserved);
        const worker = new AdminPrunePageWorker({
            database: sql,
            repository: new PSqlAdminPruneRepository(sql),
            serviceId: 'server-1',
            pageSize: 1,
            now: () => now,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' })
        });
        const command = decodeAdminPruneWork(reserved);
        const read = await worker.read(command);
        assert.deepEqual(read.candidates, [{
            rowId: '["stale-runtime-page","same-identity"]',
            revisionToken: '1'
        }]);
        const computed = worker.compute(command, read);
        worker.validate(command, read, computed);

        await sql`
            update runtime_state_store
            set store_value = '{"version":2}', revision = 2
            where store_namespace = 'stale-runtime-page' and store_key = 'same-identity'
        `;

        await assert.rejects(
            () => sql.begin(async (transaction) => await worker.write(transaction, computed)),
            /page changed before delete/i
        );
        const [runtimeRow] = await sql<{ store_value: string; revision: number | string; }[]>`
            select store_value, revision
            from runtime_state_store
            where store_namespace = 'stale-runtime-page' and store_key = 'same-identity'
        `;
        assert.deepEqual(runtimeRow, { store_value: '{"version":2}', revision: 2 });
        assert.equal((await results.findAnyByKey(aggregateEntry.key))?.resource, aggregateEntry.resource);
        assert.equal((await queueRepository.entries.findAnyByKey(reserved.key))?.status, EntityStatus.RESERVED);
    });
});
