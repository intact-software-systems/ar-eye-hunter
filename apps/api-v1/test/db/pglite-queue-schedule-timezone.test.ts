import { Temporal } from '@js-temporal/polyfill';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import assert from 'node:assert/strict';
import { createResourceEntry, readPGliteDatabaseEpochMs, withPGliteSql } from './pglite-auth-test-harness.ts';

// The naive timestamp columns hold UTC wall clocks, but the session time zone
// follows the host, so `next_ts <= now()` used to promote the column through a
// non-UTC zone and release scheduled entries hours early. These tests pin the
// scheduling gate under a deliberately skewed session in both directions.
Deno.test('PGlite scheduled entries stay invisible until next_ts under a skewed session time zone', async () => {
    await withPGliteSql(async (sql) => {
        await sql.exec('set time zone \'Etc/GMT-5\'');
        const repository = createPSqlResourceInboxRepository(sql);
        const queueBox = new PSqlQueueBox(repository);
        const nowEpochMs = await readPGliteDatabaseEpochMs(sql);

        const future = createResourceEntry('scheduled-future');
        future.dequeueAudit = {
            attempts: 0,
            nextTs: Temporal.Instant.fromEpochMilliseconds(nowEpochMs + 60_000)
        };
        const due = createResourceEntry('scheduled-due');
        due.dequeueAudit = {
            attempts: 0,
            nextTs: Temporal.Instant.fromEpochMilliseconds(nowEpochMs - 1_000)
        };
        await repository.entries.writeIfAbsentOrMatch(future);
        await repository.entries.writeIfAbsentOrMatch(due);

        const reserved = await queueBox.reserveEntries(
            new Set(['TYPE_A']),
            new Set([EntityStatus.NEW]),
            { maxToReserve: 10, maxAttempts: 20 }
        );
        assert.deepEqual(
            [...reserved.keys()].map((key) => key.resourceId),
            ['scheduled-due']
        );

        // The opposite skew direction must not hold a due entry hostage either.
        await sql.exec('set time zone \'Etc/GMT+5\'');
        const reservedOpposite = await queueBox.reserveEntries(
            new Set(['TYPE_A']),
            new Set([EntityStatus.NEW]),
            { maxToReserve: 10, maxAttempts: 20 }
        );
        assert.deepEqual([...reservedOpposite.keys()], []);
    });
});

Deno.test('PGlite retry release delay is honored under a skewed session time zone', async () => {
    await withPGliteSql(async (sql) => {
        await sql.exec('set time zone \'Etc/GMT-5\'');
        const repository = createPSqlResourceInboxRepository(sql);
        const queueBox = new PSqlQueueBox(repository);

        await repository.entries.writeIfAbsentOrMatch(createResourceEntry('retry-delayed'));
        const reserved = await queueBox.reserveEntries(
            new Set(['TYPE_A']),
            new Set([EntityStatus.NEW]),
            { maxToReserve: 10, maxAttempts: 20 }
        );
        assert.equal(reserved.size, 1);

        await queueBox.releaseEntries(
            [...reserved.values()],
            { status: EntityStatus.RETRY, delayMs: 60_000 }
        );
        const retryReserved = await queueBox.reserveEntries(
            new Set(['TYPE_A']),
            new Set([EntityStatus.RETRY]),
            { maxToReserve: 10, maxAttempts: 20 }
        );
        assert.deepEqual([...retryReserved.keys()], []);
    });
});
