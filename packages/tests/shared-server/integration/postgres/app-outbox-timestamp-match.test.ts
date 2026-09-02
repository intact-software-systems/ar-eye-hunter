import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { computeAppOutboxInsertOrMatch, writeAppOutboxInsertOrMatch } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres AppOutbox immutable timestamp matching', () => {
    postgresIt.each(['createdTs', 'expiryTs'] as const)(
        'compares %s at database microsecond precision without overwriting the existing row',
        async (field) => {
            const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
            const entry = createTimestampEntry();
            const initial = computeAppOutboxInsertOrMatch(entry);
            const candidate: ResourceEntry = {
                ...entry,
                audit: { ...entry.audit, [field]: entry.audit[field].add({ microseconds: 2 }) }
            };
            const computed = computeAppOutboxInsertOrMatch(candidate);
            const middleware = createPSqlResourceInboxRepository(sql);

            try {
                expect(await sql.begin((transaction) => writeAppOutboxInsertOrMatch(transaction, initial)))
                    .toBe('inserted');
                await expect(middleware.entries.writeIfAbsentOrMatch(candidate))
                    .rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);
                await expect(sql.begin((transaction) => writeAppOutboxInsertOrMatch(transaction, computed)))
                    .rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);

                if (field === 'createdTs') {
                    await sql`
                        update resource_inbox set created_ts = '2026-08-31 00:00:00.000002'::timestamp(6)
                        where fk_ext_bank_id = ${entry.key.contextId}
                    `;
                }
                else {
                    await sql`
                        update resource_inbox set expire_ts = '2026-09-01 00:00:00.000002'::timestamp(6)
                        where fk_ext_bank_id = ${entry.key.contextId}
                    `;
                }
                const before = await sql`
                    select ri_resource, ri_status, ri_attempts,
                           created_ts::text, expire_ts::text, start_ts::text, end_ts::text, next_ts::text
                    from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}
                `;

                expect(await middleware.entries.writeIfAbsentOrMatch(candidate)).toBe('matched');
                expect(await sql.begin((transaction) => writeAppOutboxInsertOrMatch(transaction, computed)))
                    .toBe('matched');
                expect(
                    await sql`
                    select ri_resource, ri_status, ri_attempts,
                           created_ts::text, expire_ts::text, start_ts::text, end_ts::text, next_ts::text
                    from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}
                `
                ).toEqual(before);
            }
            finally {
                try {
                    await sql`delete from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`;
                }
                finally {
                    await sql.end();
                }
            }
        }
    );
});

function createTimestampEntry(): ResourceEntry {
    const createdTs = Temporal.PlainDateTime.from('2026-08-31T00:00:00');
    return {
        key: toAppQueueKey({
            topicId: 'app-outbox-timestamps',
            resourceId: 'publication',
            contextId: `outbox-timestamps-${crypto.randomUUID()}`
        }),
        resource: 'unchanged publication bytes',
        typeId: EnqueuedType.WS_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy('postgres-outbox-test'),
            createdTs,
            expiryTs: Temporal.Instant.from('2026-09-01T00:00:00Z')
        },
        dequeueAudit: { attempts: 0 }
    };
}
