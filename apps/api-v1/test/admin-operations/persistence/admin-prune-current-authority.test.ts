import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import assert from 'node:assert/strict';
import { createApiAdminInboxService } from '../../../src/admin-operations/create-api-admin-inbox-service.ts';
import { toResilienceDto } from '../../api-v1-test-queue-resilience.ts';
import { readPGliteDatabaseEpochMs, waitForPGliteQueueRow, withUtcPGliteSql } from '../../db/pglite-auth-test-harness.ts';

Deno.test('production admin prune rereads current admin authority before creating page work', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(repository);
        const inbox = new InboxQueueReader(queue);
        const outbox = new OutboxQueueReader(queue);
        const now = await readPGliteDatabaseEpochMs(sql);
        let wakeCount = 0;
        const appAdmin = createApiAdminInboxService({
            inboxQueueReader: inbox,
            outboxQueueReader: outbox,
            wakeQueueEngine: () => {
                wakeCount += 1;
            },
            resourceInboxRepository: repository,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database: sql,
            serviceId: 'server-1',
            options: {
                waitMaxElapsedMsecs: 1,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0,
                nowEpochMs: () => now
            },
            currentAuthority: {
                readSession: () => Promise.resolve(null),
                adminClientIds: ['admin']
            }
        } as never);
        const pending = appAdmin.pruneExpired({
            adminSession: {
                clientId: 'admin',
                username: 'admin',
                sessionId: 'revoked-session',
                accessToken: 'not-persisted',
                expiresAtEpochMs: now + 60_000
            },
            requestId: 'revoked-prune',
            request: {
                categories: ['runtime-state'],
                dryRun: false
            }
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await waitForWakeCount(() => wakeCount, 1);
        wakeCount = 0;
        await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
        await pending;

        const [work] = await sql<{ count: string | number; }[]>`
      select count(*) as count from resource_inbox where ri_type_id = 'APP_OUTBOX'
    `;
        const [completion] = await sql<{ ris_status: string; ris_resource: string; }[]>`
      select ris_status, ris_resource from resource_inbox_results
      where ris_topic_id = 'ADMIN_PRUNE_EXPIRED'
        and ris_resource_id = 'revoked-prune'
    `;
        assert.equal(Number(work?.count), 0);
        assert.equal(completion?.ris_status, 'FAILED');
        assert.match(completion?.ris_resource ?? '', /admin-prune-authority-denied/u);
        assert.equal(wakeCount, 0);
    });
});

Deno.test('committed initial admin page work wakes the queue after its transaction commits', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(repository);
        const inbox = new InboxQueueReader(queue);
        const outbox = new OutboxQueueReader(queue);
        const now = await readPGliteDatabaseEpochMs(sql);
        let wakeCount = 0;
        const appAdmin = createApiAdminInboxService({
            inboxQueueReader: inbox,
            outboxQueueReader: outbox,
            wakeQueueEngine: () => {
                wakeCount += 1;
            },
            resourceInboxRepository: repository,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database: sql,
            serviceId: 'server-1',
            options: {
                waitMaxElapsedMsecs: 1_000,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0,
                nowEpochMs: () => now
            },
            currentAuthority: {
                readSession: () =>
                    Promise.resolve({
                        clientId: 'admin',
                        sessionId: 'admin-session',
                        expiresAtEpochMs: now + 60_000
                    }),
                adminClientIds: ['admin']
            }
        });
        const pending = appAdmin.pruneExpired({
            adminSession: {
                clientId: 'admin',
                username: 'admin',
                sessionId: 'admin-session',
                accessToken: 'not-persisted',
                expiresAtEpochMs: now + 60_000
            },
            requestId: 'committed-prune',
            request: {
                categories: ['runtime-state'],
                dryRun: false
            }
        });

        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await waitForWakeCount(() => wakeCount, 1);
        wakeCount = 0;
        await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());

        assert.equal(wakeCount, 1);
        const [page] = await sql<{ future: boolean; }[]>`
      select expire_ts > now() as future
      from resource_inbox
      where ri_type_id = 'APP_OUTBOX'
        and ri_topic_id = 'rallar.admin.prune-expired'
    `;
        assert.equal(page?.future, true);
        await waitForPGliteQueueRow(sql, 'APP_OUTBOX', 'NEW');
        await outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, toResilienceDto());
        await pending;
    });
});

async function waitForWakeCount(readCount: () => number, expected: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (readCount() >= expected) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for ${expected} queue wake(s)`);
}
