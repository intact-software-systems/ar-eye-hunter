import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceInboxContextClaim } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

interface InvertedRows {
    readonly olderRowId: bigint;
    readonly youngerRowId: bigint;
}

describe('Postgres resource inbox NEW claim order', () => {
    // The row-id sequence caches a block per session, so an older row can hold a higher id than a younger one.
    postgresIt('claims the older NEW row first when a younger row drew a lower id from another session', async () => {
        await withInvertedRows(async (storage, rows) => {
            expect(rows.youngerRowId).toBeLessThan(rows.olderRowId);

            const claimed = await createQueue(storage.sql).reserveEntries({
                typeIds: new Set([EnqueuedType.APP_INBOX]),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 1
            });

            expect([...claimed.values()].map((entry) => entry.key.resourceId)).toEqual(['older']);
        });
    });

    postgresIt('names the older NEW row its context head when a younger row drew a lower id from another session', async () => {
        await withInvertedRows(async (storage) => {
            const contextClaim: ResourceInboxContextClaim = { excludedContextIds: new Set() };

            const claimed = await createQueue(storage.sql).reserveEntries({
                typeIds: new Set([EnqueuedType.APP_INBOX]),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 2,
                contextClaim
            });

            expect([...claimed.values()].map((entry) => entry.key.resourceId)).toEqual(['older']);
        });
    });
});

/**
 * Session A draws its id block first and session B the next one; B inserts the older row, then A the younger,
 * so the younger row holds the lower id.
 */
async function withInvertedRows(
    verify: (storage: ResourceInboxTestStorage, rows: InvertedRows) => Promise<void>
): Promise<void> {
    const storage = await createResourceInboxTestStorage('resource_inbox_claim_order', 2);
    try {
        const blockDrawn = Promise.withResolvers<void>();
        const olderInserted = Promise.withResolvers<bigint>();
        const younger = storage.sql.begin(async (sessionA) => {
            await sessionA`select nextval('trans_inbox_seq')`;
            blockDrawn.resolve();
            await olderInserted.promise;
            return await insertNewRow(sessionA, { resourceId: 'younger', createdAgoSeconds: 5 });
        });
        await blockDrawn.promise;
        const older = await storage.sql.begin(async (sessionB) => {
            await sessionB`select nextval('trans_inbox_seq')`;
            return await insertNewRow(sessionB, { resourceId: 'older', createdAgoSeconds: 10 });
        });
        olderInserted.resolve(older);
        await verify(storage, { olderRowId: older, youngerRowId: await younger });
    }
    finally {
        await storage.close();
    }
}

async function insertNewRow(
    sql: PSqlSql,
    { resourceId, createdAgoSeconds }: { readonly resourceId: string; readonly createdAgoSeconds: number; }
): Promise<bigint> {
    const rows = await sql<{ ri_row_id: bigint; }[]>`
        insert into resource_inbox (ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
            fk_ext_bank_id, system_date, created_by, created_ts, expire_ts, ri_attempts)
        values (${resourceId}, 'app-inbox.test', ${JSON.stringify({ resourceId })}, ${EnqueuedType.APP_INBOX},
            ${EntityStatus.NEW}, 'context-1', '2026-10-21', 'server-1',
            (now() at time zone 'UTC') - (${createdAgoSeconds}::int * interval '1 second'),
            (now() at time zone 'UTC') + interval '1 day', 0)
        returning ri_row_id`;
    return BigInt(rows[0].ri_row_id);
}

function createQueue(sql: PSqlSql): PSqlQueueBox {
    return new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);
}
