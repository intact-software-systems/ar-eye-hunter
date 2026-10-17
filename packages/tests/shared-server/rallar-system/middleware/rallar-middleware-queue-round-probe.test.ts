import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { registerApplicationQueueReaderTasks } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createQueueResilience } from '../../../shared/app-inbox/fair-service-fixture.ts';
import {
    createResourceInboxTestStorage,
    recordResourceInboxStatements,
    type ResourceInboxTestStorage
} from '../../queuebox/resource-inbox-test-storage.ts';

let storage: ResourceInboxTestStorage | undefined;

afterEach(async () => {
    await storage?.close();
    storage = undefined;
});

describe('registered queue reader probes', () => {
    it('probe the AppInbox and AppOutbox lanes of one engine round with one storage statement', async () => {
        storage = await createResourceInboxTestStorage('queue_round_probe');
        const statements: string[] = [];
        const queue = new PSqlQueueBox(
            createPSqlResourceInboxRepository(recordResourceInboxStatements(storage.sql, statements), () => new Date()),
            Temporal.Now.instant
        );
        const engine = new InboxOutboxEngine();
        registerApplicationQueueReaderTasks({
            engine,
            nowEpochMs: Date.now,
            inboxQueueReader: new InboxQueueReader(queue, { laneBudgetPolicy: 'adaptive-retry', newLaneConcurrency: 1, nowEpochMs: Date.now }),
            outboxQueueReader: new OutboxQueueReader(queue),
            appInboxResilience: createQueueResilience(),
            appOutboxResilience: createQueueResilience()
        });

        // An idle pass is one round: before step 2g each lane probed in a statement of its own.
        await engine.executeOnce();
        await engine.executeOnce();

        expect(statements.filter((statement) => statement.includes('as has_new'))).toHaveLength(2);
        expect(statements).toHaveLength(2);
    });
});
