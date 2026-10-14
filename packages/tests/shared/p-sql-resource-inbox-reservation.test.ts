import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import {
    EntityStatus,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage } from '../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';

describe('PostgreSQL resource inbox reservation', () => {
    it('returns Either left for expired rows and Either right for reserved rows', async () => {
        const now = Temporal.Now.instant();
        const active = createEntry('active-1', now.add({ minutes: 5 }), now.subtract({ minutes: 2 }));
        const expired = createEntry(
            'expired-1',
            now.subtract({ seconds: 1 }),
            now.subtract({ minutes: 2 })
        );
        const { sql } = await createPSqlAdmissionTestStorage();
        const repo = createPSqlResourceInboxRepository(sql, () => new Date());
        await repo.entries.write(active);
        await repo.entries.write(expired);

        const skipped = await repo.reservations.startProcessingEntity(expired);
        expect(skipped.left).toEqual({
            kind: 'expired-or-missing',
            key: expired.key
        });

        const reserved = await repo.reservations.startProcessingEntity(active);
        expect(reserved.right?.status).toBe(EntityStatus.RESERVED);
        expect(reserved.right?.dequeueAudit.attempts).toBe(1);
        expect(reserved.right?.dequeueAudit.startTs).toBeDefined();
    });

    it('does not reserve an entry whose processing-attempt budget is exhausted', async () => {
        const now = Temporal.Now.instant();
        const exhausted = {
            ...createEntry('exhausted-20', now.add({ minutes: 5 }), now.subtract({ minutes: 2 })),
            status: EntityStatus.RETRY,
            dequeueAudit: {
                attempts: 20,
                startTs: now.subtract({ minutes: 1 }),
                endTs: now.subtract({ seconds: 31 }),
                nextTs: now.subtract({ seconds: 30 })
            }
        } satisfies ResourceEntry;
        const { sql } = await createPSqlAdmissionTestStorage();
        const repo = createPSqlResourceInboxRepository(sql, () => new Date());
        await repo.entries.write(exhausted);

        const skipped = await repo.reservations.startProcessingEntity(exhausted);

        expect(skipped.left).toEqual({
            kind: 'expired-or-missing',
            key: exhausted.key
        });
    });

    it('does not create attempt three with a configured two-attempt budget', async () => {
        const now = Temporal.Now.instant();
        const exhausted = {
            ...createEntry('exhausted-2', now.add({ minutes: 5 }), now.subtract({ minutes: 2 })),
            status: EntityStatus.RETRY,
            dequeueAudit: {
                attempts: 2,
                startTs: now.subtract({ minutes: 1 }),
                endTs: now.subtract({ seconds: 31 }),
                nextTs: now.subtract({ seconds: 30 })
            }
        } satisfies ResourceEntry;
        const { sql } = await createPSqlAdmissionTestStorage();
        const repo = createPSqlResourceInboxRepository(sql, () => new Date());
        await repo.entries.write(exhausted);

        const skipped = await repo.reservations.startProcessingEntity(exhausted, 2);

        expect(skipped.left).toEqual({
            kind: 'expired-or-missing',
            key: exhausted.key
        });
    });
});

function createEntry(resourceId: string, expiryTs: Temporal.Instant, createdAt: Temporal.Instant): ResourceEntry {
    const createdTs = createdAt.toZonedDateTimeISO('UTC');
    return {
        key: {
            topicId: 'topic-1',
            resourceId,
            contextId: 'ctx-1'
        },
        resource: JSON.stringify({ resourceId }),
        typeId: 'type-1',
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'tester',
            createdTs: createdTs.toPlainDateTime(),
            expiryTs
        },
        dequeueAudit: {
            attempts: 0
        }
    };
}
