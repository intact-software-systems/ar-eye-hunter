import { Temporal } from '@js-temporal/polyfill';
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { ResourceInboxWorkAdvertisementOptions } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

import {
    createResourceInboxTestStorage,
    recordResourceInboxStatements,
    seedResourceInboxRow,
    type ResourceInboxTestRow,
    type ResourceInboxTestStorage
} from './resource-inbox-test-storage.ts';

const INBOX_TYPES = new Set([EnqueuedType.APP_INBOX]);
const OUTBOX_TYPES = new Set([EnqueuedType.APP_OUTBOX]);
const NOTHING_ADVERTISED: DequeueController.WorkAdvertisement = {
    FINALIZATION: false,
    NEW: false,
    RETRY: false,
    FAIRNESS: false,
    TIMEOUT: false
};

let storage: ResourceInboxTestStorage;
let sql: PSqlSql;
let statements: string[];
let queue: PSqlQueueBox;

beforeAll(async () => {
    storage = await createResourceInboxTestStorage('queue_box_advertisement');
    sql = storage.sql;
    statements = [];
    queue = new PSqlQueueBox(
        createPSqlResourceInboxRepository(recordResourceInboxStatements(sql, statements), () => new Date()),
        Temporal.Now.instant
    );
});
afterAll(async () => await storage?.close());
beforeEach(async () => {
    await sql`delete from resource_inbox`;
    statements.length = 0;
});

describe('PSqlQueueBox work advertisement', () => {
    it('answers an empty queue with no lane in exactly one statement per queue', async () => {
        expect(await queue.readWorkAdvertisement(INBOX_TYPES, createWorkAdvertisementOptions())).toEqual(NOTHING_ADVERTISED);
        expect(await queue.readWorkAdvertisement(OUTBOX_TYPES, createWorkAdvertisementOptions())).toEqual(NOTHING_ADVERTISED);
        expect(statements).toHaveLength(2);
        expect(statements.every((statement) => statement.startsWith('select'))).toBe(true);
    });

    it('answers the probes of several lanes issued together with one statement, each lane on its own options', async () => {
        await seed({ resourceId: 'new-row', status: EntityStatus.NEW });
        await seed({ resourceId: 'abandoned-outbox', typeId: EnqueuedType.APP_OUTBOX, status: EntityStatus.RESERVED, attempts: 1, startedAgoSeconds: 61 });
        statements.length = 0;

        const [inbox, outbox, outboxLongLease] = await Promise.all([
            queue.readWorkAdvertisement(INBOX_TYPES, createWorkAdvertisementOptions()),
            queue.readWorkAdvertisement(OUTBOX_TYPES, createWorkAdvertisementOptions({ reservationLeaseMs: 60_000 })),
            queue.readWorkAdvertisement(OUTBOX_TYPES, createWorkAdvertisementOptions({ reservationLeaseMs: 120_000 }))
        ]);

        expect(inbox).toEqual({ ...NOTHING_ADVERTISED, NEW: true });
        expect(outbox).toEqual({ ...NOTHING_ADVERTISED, TIMEOUT: true });
        expect(outboxLongLease).toEqual(NOTHING_ADVERTISED);
        expect(statements).toHaveLength(1);
    });

    it('names the NEW, due RETRY and overdue FAIRNESS lanes from the rows that can be claimed now', async () => {
        await seed({ resourceId: 'new-row', status: EntityStatus.NEW });
        await seed({ resourceId: 'expired-new', status: EntityStatus.NEW, expired: true });
        await seed({ resourceId: 'exhausted-new', status: EntityStatus.NEW, attempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts });
        expect(await queue.readWorkAdvertisement(INBOX_TYPES, createWorkAdvertisementOptions())).toEqual({ ...NOTHING_ADVERTISED, NEW: true });

        await sql`delete from resource_inbox`;
        await seed({ resourceId: 'pending-retry', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 5, endedAgoSeconds: 4, nextInSeconds: 60 });
        expect(await queue.readWorkAdvertisement(INBOX_TYPES, createWorkAdvertisementOptions())).toEqual(NOTHING_ADVERTISED);

        await seed({ resourceId: 'due-retry', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 5, endedAgoSeconds: 4, nextInSeconds: -1 });
        expect(await queue.readWorkAdvertisement(INBOX_TYPES, createWorkAdvertisementOptions())).toEqual({ ...NOTHING_ADVERTISED, RETRY: true });

        await seed({ resourceId: 'overdue-retry', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 40, endedAgoSeconds: 39, nextInSeconds: -31 });
        expect(await queue.readWorkAdvertisement(INBOX_TYPES, createWorkAdvertisementOptions()))
            .toEqual({ ...NOTHING_ADVERTISED, RETRY: true, FAIRNESS: true });
        expect(await queue.readWorkAdvertisement(OUTBOX_TYPES, createWorkAdvertisementOptions())).toEqual(NOTHING_ADVERTISED);
    });

    it('names the TIMEOUT lane for a reservation past its lease on every probe while it stays unclaimed', async () => {
        await seed({ resourceId: 'abandoned', status: EntityStatus.RESERVED, attempts: 1, startedAgoSeconds: 61 });
        await seed({ resourceId: 'held', status: EntityStatus.RESERVED, attempts: 1, startedAgoSeconds: 59 });
        const options = createWorkAdvertisementOptions({ reservationLeaseMs: 60_000 });

        expect(await queue.readWorkAdvertisement(INBOX_TYPES, options)).toEqual({ ...NOTHING_ADVERTISED, TIMEOUT: true });
        expect(await queue.readWorkAdvertisement(INBOX_TYPES, options)).toEqual({ ...NOTHING_ADVERTISED, TIMEOUT: true });
        expect(await queue.isAnyEntryToLock(INBOX_TYPES, options)).toBe(true);
        expect(await queue.readWorkAdvertisement(INBOX_TYPES, createWorkAdvertisementOptions({ reservationLeaseMs: 120_000 })))
            .toEqual(NOTHING_ADVERTISED);
    });

    it('names the FINALIZATION lane for a stale exhausted AppInbox reservation on every probe and never for other types', async () => {
        await seed({
            resourceId: 'exhausted',
            status: EntityStatus.RESERVED,
            attempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
            startedAgoSeconds: 6 * 60
        });
        await seed({
            resourceId: 'exhausted-outbox',
            typeId: EnqueuedType.APP_OUTBOX,
            status: EntityStatus.RESERVED,
            attempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
            startedAgoSeconds: 6 * 60
        });
        const options = createWorkAdvertisementOptions({ reservationLeaseMs: 10 * 60_000 });

        expect(await queue.readWorkAdvertisement(INBOX_TYPES, options)).toEqual({ ...NOTHING_ADVERTISED, FINALIZATION: true });
        expect(await queue.readWorkAdvertisement(INBOX_TYPES, options)).toEqual({ ...NOTHING_ADVERTISED, FINALIZATION: true });
        expect(await queue.readWorkAdvertisement(OUTBOX_TYPES, createWorkAdvertisementOptions({ reservationLeaseMs: 10 * 60_000 })))
            .toEqual(NOTHING_ADVERTISED);
    });
});

async function seed(row: ResourceInboxTestRow): Promise<void> {
    await seedResourceInboxRow(sql, row);
}

function createWorkAdvertisementOptions(
    overrides: Partial<Pick<ResourceInboxWorkAdvertisementOptions, 'reservationLeaseMs'>> = {}
): ResourceInboxWorkAdvertisementOptions {
    return {
        maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        finalizationStaleAfterMs: 5 * 60_000,
        reservationLeaseMs: overrides.reservationLeaseMs ?? 5 * 60_000,
        staleDueThresholdMs: 30_000
    };
}
