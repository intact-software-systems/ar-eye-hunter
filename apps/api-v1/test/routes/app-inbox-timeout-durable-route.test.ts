import { AppInboxQueueClient, SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import * as clientStateRoutes from '../../src/routes/client-state-routes.ts';

Deno.test('HTTP wait timeout leaves its durable AppInbox row eligible', async () => {
    const queue = new InMemoryQueueBox(new Map());
    const service = new AppInboxQueueClient(
        {
            inboxQueueReader: new InboxQueueReader(queue),
            resourceInboxRepository: {
                isEntryWithStatus: async (key, statuses) => {
                    const entry = await queue.getItem(key);
                    return entry !== undefined && statuses.includes(entry.status);
                }
            },
            resourceInboxResultsRepository: {
                replace: (entry) => Promise.resolve(entry),
                findByKey: () => Promise.resolve(undefined)
            }
        },
        {
            serviceId: 'server-12345678',
            defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
            options: {
                waitMaxElapsedMsecs: 0,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0
            }
        }
    );
    let directMutationFallbacks = 0;
    const app = new Hono();
    clientStateRoutes.registerClientStateRoutes(app, {
        strictReadAuthorization: false,
        requireApiAuthSession: () =>
            Promise.resolve({
                clientId: 'alice',
                accessToken: 'token',
                username: 'alice',
                sessionId: 'alice-session',
                issuedAtEpochMs: 1,
                expiresAtEpochMs: 60_000
            }),
        clientStateService: {
            listSnapshots: () => Promise.resolve([]),
            readSnapshot: () => Promise.resolve(undefined),
            readPresenceSnapshot: () => Promise.resolve(undefined),
            listEvents: () => Promise.resolve([]),
            listRecentEvents: () => Promise.resolve([]),
            listEventPage: () => Promise.resolve({ events: [], hasMore: false })
        },
        hydrateStateSyncSnapshotCaches: () =>
            Promise.resolve({
                clientSnapshotCount: 0,
                groupSnapshotCount: 0
            }),
        readClientSnapshot: () => Promise.resolve({ status: 'not-found', source: 'durable' }),
        processClientAppInbox: async (input) => {
            return await service.processEntryUntilCompletionResult(
                input,
                () => {
                    directMutationFallbacks += 1;
                    throw new Error('Unexpected direct mutation fallback');
                }
            );
        }
    });

    const response = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal/requests/' +
            'TimeoutMutationRequest_0123',
        {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'alice' })
        }
    );

    assert.equal(response.status, 503);
    const failure = await response.json();
    assert.equal(failure.code, 'app-inbox-unavailable');
    assert.equal(failure.type, 'api-mutation-failure');
    assert.equal(failure.version, 'canonical.v2');
    assert.equal(failure.retry.kind, 'unavailable');
    assert.equal(directMutationFallbacks, 0);
    const [key] = await queue.getAllKeys();
    if (key === undefined) {
        throw new Error('Expected durable timeout AppInbox key');
    }
    const row = await queue.getItem(key);
    assert.equal(row?.status, EntityStatus.NEW);
    assert.equal(row?.dequeueAudit.attempts, 0);
});
