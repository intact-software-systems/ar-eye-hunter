import assert from 'node:assert/strict';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { createApiAdminInboxService } from '../../src/services/create-api-admin-inbox-service.ts';
import { toResilienceDto } from '../../src/middleware-resilience.ts';
import {
  readPGliteDatabaseEpochMs,
  waitForPGliteQueueRow,
  withPGliteSql,
} from './pglite-auth-test-harness.ts';

Deno.test('production admin prune rereads current admin authority before creating page work', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new ResourceInboxRepository(sql);
    const queue = new PSqlQueueBox(repository);
    const inbox = new InboxQueueReader(queue);
    const outbox = new OutboxQueueReader(queue);
    const now = await readPGliteDatabaseEpochMs(sql);
    const appAdmin = createApiAdminInboxService({
      inboxQueueReader: inbox,
      outboxQueueReader: outbox,
      wakeQueueEngine: () => undefined,
      resourceInboxRepository: repository,
      resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
      database: sql,
      serviceId: 'server-1',
      options: {
        waitMaxElapsedMsecs: 1,
        waitRetryIntervalMsecs: 0,
        waitMaxRetryIntervalMsecs: 0,
        waitJitterRatio: 0,
        nowEpochMs: () => now,
      },
      currentAuthority: {
        readSession: () => Promise.resolve(null),
        adminClientIds: ['admin'],
      },
    } as never);
    const pending = appAdmin.pruneExpired({
      adminSession: {
        clientId: 'admin', username: 'admin', sessionId: 'revoked-session', accessToken: 'not-persisted',
        expiresAtEpochMs: now + 60_000,
      },
      request: {
        requestId: 'revoked-prune', categories: ['runtime-state'], dryRun: false,
      },
    });
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
    await pending;

    const [work] = await sql<{ count: string | number }[]>`
      select count(*) as count from resource_inbox where ri_type_id = 'APP_OUTBOX'
    `;
    const [completion] = await sql<{ ris_status: string; ris_resource: string }[]>`
      select ris_status, ris_resource from resource_inbox_results
      where ris_topic_id = 'app-inbox.admin-operations'
        and ris_resource_id = 'revoked-prune'
    `;
    assert.equal(Number(work?.count), 0);
    assert.equal(completion?.ris_status, 'FAILED');
    assert.match(completion?.ris_resource ?? '', /admin-prune-authority-denied/u);
  });
});
