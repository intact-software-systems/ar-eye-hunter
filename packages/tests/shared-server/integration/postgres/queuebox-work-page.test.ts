import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres QueueBox work pages', () => {
    postgresIt('reads bounded pages in a read-only transaction and claims only unchanged observations', async () => {
        const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        const typeId = crypto.randomUUID();
        onTestFinished(async () => {
            try {
                await sql`delete from resource_inbox where ri_type_id = ${typeId}`;
            }
            finally {
                await sql.end();
            }
        });
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql));
        for (const resourceId of ['first', 'second', 'waiting']) {
            await queue.enqueue(createEntry(typeId, resourceId));
        }
        const request = { typeId, status: EntityStatus.NEW, maxToRead: 2, cursor: null } as const;
        const page = await sql.begin(async (transaction) => {
            await transaction`set transaction read only`;
            const reader = new PSqlQueueBox(createPSqlResourceInboxRepository(transaction));
            return await reader.readWorkPage(request);
        });
        expect(page.entries.map((entry) => entry.resource)).toEqual(['first', 'second']);
        expect(page.entries.map((entry) => entry.dequeueAudit.attempts)).toEqual([0, 0]);
        expect(page.nextCursor).not.toBeNull();
        const next = await queue.readWorkPage({ ...request, cursor: page.nextCursor });
        expect(next.entries.map((entry) => entry.resource)).toEqual(['waiting']);
        expect(next.nextCursor).toBeNull();

        await queue.replaceIfObserved(page.entries[0], { ...page.entries[0], resource: 'replacement' });
        const claimed = await queue.reserveEntries({
            typeIds: new Set([typeId]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 2,
            observedEntries: page.entries
        });
        expect([...claimed.values()]).toMatchObject([{ resource: 'second', dequeueAudit: { attempts: 1 } }]);
        expect(await queue.getItem(next.entries[0].key)).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });

        for (
            const position of [
                '0',
                '-1',
                '1.5',
                '9223372036854775808',
                'not-a-row',
                '2026-01-01T12:00:00.1234567/1',
                '2026-13-01T12:00:00/1',
                '2026-01-01T12:00:00/9223372036854775808'
            ]
        ) {
            await expect(queue.readWorkPage({ ...request, cursor: { typeId, status: EntityStatus.NEW, position } }))
                .rejects.toBeInstanceOf(TypeError);
        }
    });
});

function createEntry(typeId: string, resourceId: string): ResourceEntry {
    return {
        key: { topicId: 'queue-work-page', resourceId, contextId: typeId },
        typeId,
        resource: resourceId,
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00.123456'),
            expiryTs: NEVER_EXPIRE_TS
        },
        dequeueAudit: { attempts: 0 },
        db: undefined
    };
}
