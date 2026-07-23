import { expect, it } from 'vitest';

import type { StateScope } from '@shared/api/state-types.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import {
  type AppGroupInboxService,
  type AppInboxEnqueueInput,
  type GroupCreateAppInboxPayload,
  type GroupPresenceConnectAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { toAuthorisedWsClientConnectEnqueue } from '@shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts';
import type { GroupStateWritten } from '@shared-server/rallar-system/services/group-state-service.ts';
import { processNext, waitForQueuedType } from './app-inbox-queue-entry-test-helpers.ts';
import {
  createAppInboxWsCloseHarness as createHarness,
  createAuthorisedWsCloseFacts as closeFacts,
} from './app-inbox-ws-close-test-harness.ts';

const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

it('bounds a lost-close group guard to the shared retry retention horizon', async () => {
  const harness = await createHarness();
  const groupId = 'lost-close-retention-room';
  await createRoom(harness, groupId);
  const facts = closeFacts(harness.authSession, 'lost-close-generation', 45);
  const connectedAtEpochMs = facts.input.connectedAtEpochMs - 50;

  const pending = processAuthenticated<GroupPresenceConnectAppInboxPayload, GroupStateWritten>(
    harness.group,
    harness.authSession,
    {
      type: AppInboxType.GROUP_PRESENCE_CONNECT,
      resourceId: 'presence-lost-close',
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
      senderId: harness.authSession.clientId,
      data: {
        scope: SCOPE,
        groupId,
        sessionId: harness.authSession.sessionId,
        request: {
          principalId: harness.authSession.clientId,
          generationId: 'lost-close-presence',
          connectedAtEpochMs,
          lastHeartbeatAtEpochMs: connectedAtEpochMs,
          expiresAtEpochMs: 253_402_300_799_999,
          actorPrincipalId: harness.authSession.clientId,
          actorSessionId: harness.authSession.sessionId,
          requestId: 'presence-lost-close',
        },
      },
    },
  );
  await waitForQueuedType(harness.queue, AppInboxType.GROUP_PRESENCE_CONNECT);
  await processNext(harness.reader);
  await pending;

  const lifecycle = await harness.groupState.sessionGenerationLifecycle.read({
    scope: {
      kind: 'group',
      ...SCOPE,
      principalId: harness.authSession.clientId,
    },
    sessionId: harness.authSession.sessionId,
  });
  const expectedExpiry = resourceInboxRetryExpiryAtEpochMs(connectedAtEpochMs);
  expect(lifecycle.state?.status).toBe('open');
  expect(lifecycle.state?.expireAtEpochMs).toBe(expectedExpiry);
  expect(lifecycle.entry?.expireAtTimestamp).toBe(expectedExpiry);
  expect(expectedExpiry).toBeLessThan(253_402_300_799_999);

  await harness.group.enqueueGroupSessionCleanup({
    connection: toAuthorisedWsClientConnectEnqueue({
      authSession: facts.authSession,
      generationId: facts.generationId,
      input: { ...facts.input, expiresAtEpochMs: 253_402_300_799_999 },
    }).data,
    disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
    reason: facts.reason,
  });
  await processNext(harness.reader);
  const closed = await harness.groupState.sessionGenerationLifecycle.read(lifecycle.identity);
  const expectedCloseExpiry = resourceInboxRetryExpiryAtEpochMs(facts.disconnectedAtEpochMs);
  expect(closed.state?.status).toBe('closed');
  expect(closed.state?.expireAtEpochMs).toBe(expectedCloseExpiry);
  expect(closed.entry?.expireAtTimestamp).toBe(expectedCloseExpiry);
});

async function createRoom(
  harness: Awaited<ReturnType<typeof createHarness>>,
  groupId: string,
): Promise<void> {
  const pending = processAuthenticated<GroupCreateAppInboxPayload, GroupStateWritten>(
    harness.group,
    harness.authSession,
    {
      type: AppInboxType.GROUP_CREATE,
      resourceId: `create-${groupId}`,
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
      senderId: harness.authSession.clientId,
      data: {
        scope: SCOPE,
        request: {
          groupId,
          displayName: groupId,
          kind: 'room',
          joinMode: 'open',
          createdByPrincipalId: harness.authSession.clientId,
          actorPrincipalId: harness.authSession.clientId,
          actorSessionId: harness.authSession.sessionId,
          requestId: `create-${groupId}`,
        },
      },
    },
  );
  await waitForQueuedType(harness.queue, AppInboxType.GROUP_CREATE);
  await processNext(harness.reader);
  expect((await pending).right?.status).toBe('created');
}

function processAuthenticated<V, R>(
  service: AppGroupInboxService,
  authority: IssuedAuthSession,
  enqueue: AppInboxEnqueueInput<V>,
): Promise<import('@shared/resilience/Either.ts').Either<string, R>> {
  return service.processAuthenticatedEntryUntilCompletion<V, R>(enqueue, authority);
}
