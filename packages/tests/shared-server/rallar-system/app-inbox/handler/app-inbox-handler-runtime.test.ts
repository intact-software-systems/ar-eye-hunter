import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createQueueResilience } from '../../../../shared/app-inbox/fair-service-fixture.ts';

describe('createAppInboxHandlerRuntime', () => {
    it('leaves the dequeue-pass observer to the reader owner when several services compose on one reader with phase timing', async () => {
        const reader = new InboxQueueReader(new InMemoryQueueBox(), { laneBudgetPolicy: 'fixed-retry-two' });
        const probes: string[] = [];
        reader.onDequeuePassDo({
            onProbeStarted: () => void probes.push('started'),
            onProbeFinished: () => void probes.push('finished'),
            onPassStarted: () => undefined,
            onPassFinished: () => undefined,
            onHandlerStarted: () => undefined,
            onHandlerFinished: () => undefined
        });
        for (const serviceId of ['group-state', 'client-state']) {
            createAppInboxHandlerRuntime({
                inboxQueueReader: reader,
                resultRepository: { replace: async (entry) => entry, findByKey: async () => undefined },
                database: createIdleDatabase(),
                serviceId,
                timing: () => undefined,
                options: { phaseTiming: true }
            });
        }

        await reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());

        expect(probes).toEqual(['started', 'finished']);
    });
});

/** A port nothing queries: the runtime under test composes handlers and never runs one. */
function createIdleDatabase(): PSqlSql {
    const database = Object.assign(
        (): Promise<readonly object[]> => Promise.resolve([]),
        { begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => await write(database) }
    ) as PSqlSql;
    return database;
}
