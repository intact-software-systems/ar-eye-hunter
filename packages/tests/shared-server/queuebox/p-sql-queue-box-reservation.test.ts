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
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

import {
    createResourceInboxTestStorage,
    recordResourceInboxStatements,
    seedResourceInboxRow,
    type ResourceInboxTestRow,
    type ResourceInboxTestStorage
} from './resource-inbox-test-storage.ts';

const INBOX_TYPES = new Set([EnqueuedType.APP_INBOX]);

let storage: ResourceInboxTestStorage;
let sql: PSqlSql;
let statements: string[];
let repository: PSqlResourceInboxRepository;
let queue: PSqlQueueBox;

beforeAll(async () => {
    storage = await createResourceInboxTestStorage('queue_box_reservation');
    sql = storage.sql;
    statements = [];
    repository = createPSqlResourceInboxRepository(recordResourceInboxStatements(sql, statements), () => new Date());
    queue = new PSqlQueueBox(repository, Temporal.Now.instant);
});
afterAll(async () => await storage?.close());
beforeEach(async () => {
    await sql`delete from resource_inbox`;
    statements.length = 0;
});

describe('PSqlQueueBox reservation claim', () => {
    it('claims the next NEW row in one statement with the lease and attempt a reservation carries', async () => {
        await seed({ resourceId: 'second', status: EntityStatus.NEW });
        await seed({ resourceId: 'first', status: EntityStatus.NEW });
        await sql`update resource_inbox set ri_row_id = ri_row_id - 1000 where ri_resource_id = 'first'`;

        const reserved = await queue.reserveEntries({ typeIds: INBOX_TYPES, statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 });

        expect(statements).toEqual(['begin', expect.any(String), 'commit']);
        const [claimed] = reserved.values();
        expect(claimed).toMatchObject({
            key: expect.objectContaining({ resourceId: 'first' }),
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1, startTs: expect.any(Temporal.Instant), endTs: undefined, nextTs: undefined }
        });
        expect(await readLifecycle('first')).toEqual({ status: EntityStatus.RESERVED, attempts: 1, started: true, next: false });
        expect(await readLifecycle('second')).toEqual({ status: EntityStatus.NEW, attempts: 0, started: false, next: false });
    });

    it('claims up to the requested count in row order and skips exhausted, expired, scheduled and not-yet-due rows', async () => {
        await seed({ resourceId: 'exhausted', status: EntityStatus.NEW, attempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts });
        await seed({ resourceId: 'expired', status: EntityStatus.NEW, expired: true });
        await seed({ resourceId: 'scheduled', status: EntityStatus.NEW, nextInSeconds: 60 });
        await seed({ resourceId: 'pending-retry', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 5, endedAgoSeconds: 4, nextInSeconds: 60 });
        await seed({ resourceId: 'due-retry', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 5, endedAgoSeconds: 4, nextInSeconds: -1 });
        await seed({ resourceId: 'new-a', status: EntityStatus.NEW });
        await seed({ resourceId: 'new-b', status: EntityStatus.NEW });

        const newRows = await queue.reserveEntries({ typeIds: INBOX_TYPES, statusIds: new Set([EntityStatus.NEW]), reservationInput: 5 });
        const retryRows = await queue.reserveEntries({ typeIds: INBOX_TYPES, statusIds: new Set([EntityStatus.RETRY]), reservationInput: 5 });

        expect([...newRows.values()].map((entry) => entry.key.resourceId)).toEqual(['new-a', 'new-b']);
        expect([...retryRows.values()].map((entry) => [entry.key.resourceId, entry.dequeueAudit.attempts])).toEqual([['due-retry', 2]]);
        expect(statements.filter((statement) => statement.startsWith('update'))).toHaveLength(2);
    });

    it('claims a row exactly as starting its processing would and never past the attempt budget', async () => {
        await seed({ resourceId: 'by-claim', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 5, endedAgoSeconds: 4, nextInSeconds: -1 });
        await seed({ resourceId: 'by-start', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 5, endedAgoSeconds: 4, nextInSeconds: -1 });

        const [claimed] = (await queue.reserveEntries({
            typeIds: INBOX_TYPES,
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: { maxToReserve: 1, maxAttempts: 2 }
        })).values();
        const started = await repository.reservations.startProcessingEntity(
            (await repository.entries.findByKey({ topicId: 'app-inbox.test', resourceId: 'by-start', contextId: 'context-1' }))!,
            2
        );
        const exhausted = await queue.reserveEntries({
            typeIds: INBOX_TYPES,
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: { maxToReserve: 1, maxAttempts: 1 }
        });

        expect(claimed?.key.resourceId).toBe('by-claim');
        expect(toComparableLifecycle(claimed!)).toEqual(toComparableLifecycle(started.right!));
        expect(exhausted.size).toBe(0);
    });

    it('claims an observed row only while it still matches the observation, in a transaction that reads before it starts', async () => {
        const key = await seed({ resourceId: 'observed', status: EntityStatus.NEW });
        const observed = (await repository.entries.findByKey(key))!;
        statements.length = 0;

        await sql`update resource_inbox set ri_resource = '{"changed":true}' where ri_resource_id = 'observed'`;
        const stale = await queue.reserveEntries({
            typeIds: INBOX_TYPES,
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1,
            observedEntries: [observed]
        });
        const fresh = await queue.reserveEntries({
            typeIds: INBOX_TYPES,
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1,
            observedEntries: [(await repository.entries.findByKey(key))!]
        });

        expect(stale.size).toBe(0);
        expect([...fresh.values()].map((entry) => entry.status)).toEqual([EntityStatus.RESERVED]);
        expect(statements.filter((statement) => statement === 'begin')).toHaveLength(2);
    });
});

async function seed(row: ResourceInboxTestRow) {
    return await seedResourceInboxRow(sql, row);
}

async function readLifecycle(resourceId: string) {
    const [row] = await sql<readonly { ri_status: string; ri_attempts: bigint | number; start_ts: string | null; next_ts: string | null; }[]>`
        select ri_status, ri_attempts, start_ts, next_ts from resource_inbox where ri_resource_id = ${resourceId}
    `;
    return { status: row?.ri_status, attempts: Number(row?.ri_attempts), started: row?.start_ts !== null, next: row?.next_ts !== null };
}

function toComparableLifecycle(entry: ResourceEntry) {
    return {
        status: entry.status,
        attempts: entry.dequeueAudit.attempts,
        started: entry.dequeueAudit.startTs !== undefined,
        endTs: entry.dequeueAudit.endTs,
        nextTs: entry.dequeueAudit.nextTs
    };
}
