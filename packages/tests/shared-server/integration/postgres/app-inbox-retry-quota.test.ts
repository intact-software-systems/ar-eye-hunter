import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createQueueResilience } from '../../../shared/app-inbox/fair-service-fixture.ts';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

const TYPE = 'app-inbox.retry-quota.v1';

/** A command moved out of NEW on the database clock: its claim, its release and its due time, in seconds ago. */
interface MovedRow {
    readonly resourceId: string;
    readonly status: EntityStatus;
    readonly attempts: number;
    readonly startedAgoSeconds: number;
    readonly endedAgoSeconds: number | null;
    readonly dueAgoSeconds: number | null;
}

const NEW_ROWS = ['new-a', 'new-b'];
/** One row per lane but NEW, except RETRY, which holds three due rows. */
const MOVED_ROWS: readonly MovedRow[] = [
    {
        resourceId: 'stale-exhausted',
        status: EntityStatus.RESERVED,
        attempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        startedAgoSeconds: 360,
        endedAgoSeconds: null,
        dueAgoSeconds: null
    },
    { resourceId: 'overdue', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 40, endedAgoSeconds: 39, dueAgoSeconds: 31 },
    { resourceId: 'due-a', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 10, endedAgoSeconds: 9, dueAgoSeconds: 4 },
    { resourceId: 'due-b', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 10, endedAgoSeconds: 9, dueAgoSeconds: 3 },
    { resourceId: 'due-c', status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 10, endedAgoSeconds: 9, dueAgoSeconds: 2 },
    { resourceId: 'lease-expired', status: EntityStatus.RESERVED, attempts: 1, startedAgoSeconds: 360, endedAgoSeconds: null, dueAgoSeconds: null }
];

describe('the AppInbox RETRY quota on PostgreSQL', () => {
    postgresIt('claims two of three due retries beside the NEW share, in FINALIZATION, NEW, FAIRNESS, RETRY, TIMEOUT order', async () => {
        const storage = await createResourceInboxTestStorage('app_inbox_retry_quota');
        try {
            const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(storage.sql, () => new Date()), Temporal.Now.instant);
            const claimed: string[] = [];
            const reader = createReader(queue, claimed);
            reader.onDequeuePassDo({
                onProbeStarted: () => undefined,
                onProbeFinished: () => undefined,
                onPassStarted: () => undefined,
                onEntryClaimed: (attempt) => void claimed.push(`${attempt.telemetry.selectedLane}:${attempt.entry.key.resourceId}`),
                onHandlerStarted: () => undefined,
                onHandlerFinished: () => undefined,
                onPassFinished: () => undefined
            });
            reader.onInboxMessageDo(TYPE, { onMessage: async () => undefined });
            await seedRows(reader, storage.sql);
            const resilience = createQueueResilience();

            const advertisedLanes = await reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, advertisedLanes);

            expect(advertisedLanes).toEqual({ FINALIZATION: true, NEW: true, FAIRNESS: true, RETRY: true, TIMEOUT: true });
            expect(claimed).toEqual([
                'FINALIZATION:stale-exhausted',
                'NEW:new-a',
                'NEW:new-b',
                'FAIRNESS:overdue',
                'RETRY:due-a',
                'RETRY:due-b',
                'TIMEOUT:lease-expired'
            ]);
            expect(await readStatus(storage.sql, 'due-c')).toEqual({ ri_status: EntityStatus.RETRY, ri_attempts: 1 });
        }
        finally {
            await storage.close();
        }
    });
});

/** A finalization claim runs no handler, so the recovery records it beside the claims the pass observer reports. */
function createReader(queue: PSqlQueueBox, claimed: string[]): InboxQueueReader {
    return new InboxQueueReader(queue, {
        newLaneConcurrency: 4,
        onRetryExhaustionRecovery: async (recovery) => {
            claimed.push(`FINALIZATION:${recovery.entry.key.resourceId}`);
            const [failed] = (await queue.releaseEntries([
                { entry: recovery.entry, disposition: { status: EntityStatus.FAILED, delayMs: null } }
            ])).values();
            return failed;
        }
    });
}

/** Every row is a real command in a context of its own, enqueued as NEW and then moved to its lane. */
async function seedRows(reader: InboxQueueReader, sql: PSqlSql): Promise<void> {
    for (const resourceId of [...NEW_ROWS, ...MOVED_ROWS.map((row) => row.resourceId)]) {
        await reader.enqueueIfAbsent(newALUntargetedMessage(
            'api-v1',
            newALRoute('app-inbox.retry-quota', `context-${resourceId}`, resourceId),
            TYPE,
            { resourceId },
            { ttlMs: 3_600_000 }
        ));
    }
    for (const row of MOVED_ROWS) {
        await sql`
            update resource_inbox
            set ri_status = ${row.status}, ri_attempts = ${row.attempts},
                start_ts = (now() at time zone 'UTC') - (${row.startedAgoSeconds}::int * interval '1 second'),
                end_ts = case when ${row.endedAgoSeconds}::int is null then null
                    else (now() at time zone 'UTC') - (${row.endedAgoSeconds}::int * interval '1 second') end,
                next_ts = case when ${row.dueAgoSeconds}::int is null then null
                    else (now() at time zone 'UTC') - (${row.dueAgoSeconds}::int * interval '1 second') end
            where ri_resource_id = ${row.resourceId}
        `;
    }
}

interface StatusRow {
    ri_status: string;
    ri_attempts: number;
}

async function readStatus(sql: PSqlSql, resourceId: string): Promise<StatusRow> {
    const [row] = await sql<StatusRow[]>`
        select ri_status, ri_attempts::int as ri_attempts from resource_inbox where ri_resource_id = ${resourceId}`;
    return row;
}
