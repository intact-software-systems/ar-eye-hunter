import { Temporal } from '@js-temporal/polyfill';
import { expect, it } from 'vitest';

import { RallarServerAppInbox } from '@shared-server/mod.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { CounterService } from '../../../../examples/server-app-inbox/counter-service.ts';
import { createResourceInboxTestStorage } from '../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';

it('runs the public counter example through admission, conditional write and exact replay', async () => {
    const storage = await createResourceInboxTestStorage('counter_example', 4);
    try {
        await storage.sql`create table app_counter (id text primary key, value integer not null, revision integer not null)`;
        await storage.sql`insert into app_counter values ('visits', 2, 0)`;
        const resources = createPSqlResourceInboxRepository(storage.sql, () => new Date());
        const reader = new InboxQueueReader(new PSqlQueueBox(resources, Temporal.Now.instant), { newLaneConcurrency: 1 });
        const appInbox = new RallarServerAppInbox({
            inboxQueueReader: reader,
            resourceInboxRepository: resources.entries,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(storage.sql),
            database: storage.sql,
            wakeOwningQueue: () => {}
        }, { serviceId: 'counter-example', options: {} });
        const counters = new CounterService({ appInbox, database: storage.sql, nowEpochMs: () => 101 });
        appInbox.start();
        const command = { counterId: 'visits', requestId: 'click-1', capturedAtEpochMs: null };
        const admitted = await counters.increment.enqueue(command);
        expect(admitted.left).toBeUndefined();
        expect(await storage.sql`select value, revision from app_counter`).toEqual([{ value: 2, revision: 0 }]);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        const exact = { status: 'updated', counterId: 'visits', value: 3, capturedAtEpochMs: 101 };
        expect((await admitted.right!.wait()).right).toEqual(exact);
        expect((await counters.increment.submit(command)).right).toEqual(exact);
        expect(await storage.sql`select value, revision from app_counter`).toEqual([{ value: 3, revision: 1 }]);
        const missing = await counters.increment.enqueue({ ...command, counterId: 'other' });
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await missing.right!.wait()).right).toEqual({ status: 'refused', counterId: 'other', capturedAtEpochMs: 101, code: 'counter-unavailable' });
    }
    finally {
        await storage.close();
    }
}, 30_000);
