import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
  AppInboxService,
  SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import * as clientStateRoutes from '../../src/routes/client-state-routes.ts';

Deno.test('HTTP wait timeout leaves its durable AppInbox row eligible', async () => {
  const queue = new InMemoryQueueBox(new Map());
  const service = new AppInboxService(
    {
      inboxQueueReader: new InboxQueueReader(queue),
      resourceInboxRepository: {
        isEntryWithStatus: () => Promise.resolve(false),
      } as never,
      resourceInboxResultsRepository: {} as never,
      database: {} as never,
    },
    {
      serviceId: 'server-12345678',
      defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
      options: {
        waitMaxElapsedMsecs: 0,
        waitRetryIntervalMsecs: 0,
        waitMaxRetryIntervalMsecs: 0,
        waitJitterRatio: 0,
      },
    },
  );
  let directMutationFallbacks = 0;
  const app = new Hono();
  clientStateRoutes.registerClientStateRoutes(app, {
    requireApiAuthSession: () =>
      Promise.resolve({
        clientId: 'alice',
        accessToken: 'token',
        username: 'alice',
        sessionId: 'alice-session',
        issuedAtEpochMs: 1,
        expiresAtEpochMs: 60_000,
      }),
    clientStateService: {
      listSnapshots: () => Promise.resolve([]),
      readSnapshot: () => Promise.resolve(undefined),
      readPresenceSnapshot: () => Promise.resolve(undefined),
      listEvents: () => Promise.resolve([]),
      listRecentEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
    },
    hydrateStateSyncSnapshotCaches: () =>
      Promise.resolve({
        clientSnapshotCount: 0,
        groupSnapshotCount: 0,
      }),
    readClientSnapshot: () => Promise.resolve({ status: 'not-found', source: 'durable' }),
    processClientAppInbox: async (input) => {
      const result = await service.processEntryUntilCompletion(input);
      return result.fold(
        (failure) => {
          throw clientStateRoutes.toClientAppInboxError(failure);
        },
        () => {
          directMutationFallbacks += 1;
          throw new Error('Unexpected direct mutation fallback');
        },
      );
    },
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'timeout-command', username: 'alice' }),
    },
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'app-inbox-unavailable');
  assert.equal(directMutationFallbacks, 0);
  const [key] = await queue.getAllKeys();
  const row = await queue.getItem(key!);
  assert.equal(row?.status, EntityStatus.NEW);
  assert.equal(row?.dequeueAudit.attempts, 0);
});
