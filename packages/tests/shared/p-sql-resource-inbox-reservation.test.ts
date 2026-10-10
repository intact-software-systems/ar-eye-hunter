import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage } from '../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';

describe('PostgreSQL resource inbox reservation', () => {
    it('returns Either left for expired rows and Either right for reserved rows', async () => {
        const active = createEntry('active-1', Temporal.Now.instant().add({ minutes: 5 }));
        const expired = createEntry(
            'expired-1',
            Temporal.Now.instant().subtract({ seconds: 1 })
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
        const exhausted = {
            ...createEntry('exhausted-20', Temporal.Now.instant().add({ minutes: 5 })),
            status: EntityStatus.RETRY,
            dequeueAudit: {
                attempts: 20,
                startTs: Temporal.Now.instant().subtract({ minutes: 1 }),
                endTs: Temporal.Now.instant().subtract({ seconds: 31 }),
                nextTs: Temporal.Now.instant().subtract({ seconds: 30 })
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
        const exhausted = {
            ...createEntry('exhausted-2', Temporal.Now.instant().add({ minutes: 5 })),
            status: EntityStatus.RETRY,
            dequeueAudit: {
                attempts: 2,
                startTs: Temporal.Now.instant().subtract({ minutes: 1 }),
                endTs: Temporal.Now.instant().subtract({ seconds: 31 }),
                nextTs: Temporal.Now.instant().subtract({ seconds: 30 })
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

function createEntry(resourceId: string, expiryTs: Temporal.Instant): ResourceEntry {
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
            date: Temporal.Now.plainDateTimeISO().toPlainTime(),
            createdBy: 'tester',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs
        },
        dequeueAudit: {
            attempts: 0
        }
    };
}
