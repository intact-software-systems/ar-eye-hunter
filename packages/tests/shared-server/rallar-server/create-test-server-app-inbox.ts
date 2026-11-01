import { Temporal } from '@js-temporal/polyfill';
import { RallarServerAppInbox } from '@shared-server/mod.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { TestResourceInbox, TestResourceInboxResults } from '../rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from '../rallar-system/app-inbox/test-support/app-inbox-test-database.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';

export function createTestServerAppInbox(): RallarServerAppInbox {
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    return new RallarServerAppInbox({
        inboxQueueReader: new InboxQueueReader(queue, { newLaneConcurrency: 1 }),
        resourceInboxRepository: {
            findByKey: (key) => queue.getItem(key),
            readStatusAndAttempts: (key) => queue.readStatusAndAttempts(key),
            writeMaterializedIfAbsentOrReplaceExpired: (entry, materialize) => queue.writeMaterializedIfAbsentOrReplaceExpired(entry, materialize)
        },
        resourceInboxResultsRepository: results,
        database: createAppInboxTestDatabase(queue, results),
        wakeOwningQueue: () => {}
    }, { serviceId: 'application-test', finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS, options: {} });
}

export interface SqlServerAppInboxTestRuntime {
    readonly inbox: RallarServerAppInbox;
    readonly reader: InboxQueueReader;
    readonly outbox: OutboxQueueReader;
}

export interface SqlServerAppInboxTestInput {
    readonly database: PSqlSql;
    readonly nowEpochMs: () => number;
}

export function createSqlServerAppInbox({ database, nowEpochMs }: SqlServerAppInboxTestInput): SqlServerAppInboxTestRuntime {
    const now = () => Temporal.Instant.fromEpochMilliseconds(nowEpochMs());
    const entries = createPSqlResourceInboxRepository(database, () => new Date(nowEpochMs()));
    const queue = new PSqlQueueBox(entries, now);
    const reader = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
    const outbox = new OutboxQueueReader(queue, now);
    const inbox = new RallarServerAppInbox({
        inboxQueueReader: reader,
        resourceInboxRepository: entries.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(database),
        database,
        wakeOwningQueue: () => {}
    }, {
        serviceId: 'application-test',
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        options: { waitMaxElapsedMsecs: 2000, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 5, waitJitterRatio: 0 }
    });
    return { inbox, reader, outbox };
}
