import { RallarServerAppInbox } from '@shared-server/mod.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { TestResourceInbox, TestResourceInboxResults } from '../rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from '../rallar-system/app-inbox/test-support/app-inbox-test-database.ts';

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
    }, { serviceId: 'application-test', options: {} });
}
