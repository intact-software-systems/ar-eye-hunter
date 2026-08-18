import { vi } from 'vitest';

import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateSnapshots } from '@shared-web/browser/api-workflows.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';

import {
  createActiveClientSessionFixture,
  createClientSnapshotFixture,
  createGroupSnapshotFixture,
} from '../authoritative-group-fixtures.ts';

const peopleEventMocks = await vi.hoisted(async () => {
  const { createApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
  const context = createApiMiddlewareTestDouble();

  return {
    session: context.session,
    context,
    hydrateStateCaches: vi.fn(async (): Promise<void> => undefined),
    initMiddleware: vi.fn(async (): Promise<ApiMiddleware> => context),
    isMiddlewareReady: vi.fn(() => false),
    listStateClientEvents: vi.fn(async (_principalId: string): Promise<ClientEvent[]> => []),
    listStateClientEventPage: vi.fn(
      async (_principalId: string): Promise<StateEventPage<ClientEvent>> => ({
        events: [],
        hasMore: false,
      }),
    ),
    refreshStateSnapshots: vi.fn(async (): Promise<StateSnapshots> => ({
      clients: [],
      groups: [],
    })),
    clientRepositoryMissing: vi.fn((): never => {
      throw new Error('Repository not found: shared.repository.client-state-snapshots');
    }),
    groupRepositoryMissing: vi.fn((): never => {
      throw new Error('Repository not found: shared.repository.group-state-snapshots');
    }),
  };
});

vi.mock(import('@shared-web/browser/app-context.ts'), () => ({
  clearMiddleware: vi.fn(),
  getMiddleware: vi.fn(() => peopleEventMocks.context),
  initMiddleware: peopleEventMocks.initMiddleware,
  isMiddlewareReady: peopleEventMocks.isMiddlewareReady,
}));

vi.mock(import('@shared-web/browser/api-integration.ts'), () => ({
  listStateClientEventPage: peopleEventMocks.listStateClientEventPage,
  listStateClientEvents: peopleEventMocks.listStateClientEvents,
  listStateGroupEventPage: vi.fn(),
  listStateGroupEvents: vi.fn(),
}));

vi.mock(import('@shared-web/browser/api-workflows.ts'), () => ({
  refreshStateSnapshots: peopleEventMocks.refreshStateSnapshots,
}));

vi.mock(import('@shared-web/browser/data-caches.ts'), () => ({
  hydrateStateCaches: peopleEventMocks.hydrateStateCaches,
  onStateCacheChange: vi.fn(() => vi.fn()),
}));

vi.mock(import('@shared/api/auth.ts'), () => ({
  clearSession: vi.fn(),
  isLoggedIn: vi.fn(() => true),
  readSession: vi.fn(() => peopleEventMocks.session),
  writeSession: vi.fn(),
}));

vi.mock(import('@shared/repository/client-state-snapshots-repository.ts'), () => ({
  findClientStateSnapshotByPrincipalId: peopleEventMocks.clientRepositoryMissing,
  getAllClientStateSnapshots: peopleEventMocks.clientRepositoryMissing,
}));

vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), () => ({
  findFirstGroupStateSnapshotRefSessionIdIsIn: peopleEventMocks.groupRepositoryMissing,
  findGroupStateSnapshotByRef: peopleEventMocks.groupRepositoryMissing,
  getAllGroupStateSnapshots: peopleEventMocks.groupRepositoryMissing,
}));

export function readPeopleEventMocks(): typeof peopleEventMocks {
  return peopleEventMocks;
}

export function resetPeopleEventTestRuntime(): void {
  vi.clearAllMocks();
  peopleEventMocks.hydrateStateCaches.mockResolvedValue(undefined);
  peopleEventMocks.initMiddleware.mockResolvedValue(peopleEventMocks.context);
  peopleEventMocks.isMiddlewareReady.mockReturnValue(false);
  peopleEventMocks.listStateClientEvents.mockRejectedValue(new Error('client events not mocked'));
  peopleEventMocks.listStateClientEventPage.mockRejectedValue(
    new Error('client event page not mocked'),
  );
  peopleEventMocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
  peopleEventMocks.clientRepositoryMissing.mockImplementation(() => {
    throw new Error('Repository not found: shared.repository.client-state-snapshots');
  });
  peopleEventMocks.groupRepositoryMissing.mockImplementation(() => {
    throw new Error('Repository not found: shared.repository.group-state-snapshots');
  });
  const { webSocketQueueBox, webRtcConnectionService } = peopleEventMocks.context.middleware;
  vi.mocked(webSocketQueueBox.close).mockImplementation((code, reason) => {
    webSocketQueueBox.socket.close(code, reason);
  });
  vi.mocked(webSocketQueueBox.onAnyInboxMessageDo).mockReturnValue(webSocketQueueBox);
  vi.mocked(webSocketQueueBox.removeAnyInboxMessageCallback).mockReturnValue(true);
  vi.mocked(webRtcConnectionService.onRtcPeerLifecycleDo).mockReturnValue(webRtcConnectionService);
}

export function findPeopleWsCallback(
  latest = false,
): { onMessage?: (message: unknown) => Promise<void> } | undefined {
  const calls = vi
    .mocked(peopleEventMocks.context.middleware.webSocketQueueBox.onAnyInboxMessageDo)
    .mock.calls.filter(([callbackId]) => callbackId === 'rallar:ws:any-message');
  const call = latest ? calls.at(-1) : calls[0];
  return call?.[1] as { onMessage?: (message: unknown) => Promise<void> } | undefined;
}

export function toPeopleEventMessage(event: ClientEvent) {
  return newALBroadcastMessage(
    'server-1',
    newALEventRoute(AppTopics.clientStateEvent, event.principalId, event.eventId),
    'all',
    AppTopics.clientStateEvent,
    event,
  );
}

export function createPeopleEvent(
  principalId: string,
  eventId: string,
  eventType: ClientEvent['eventType'],
  scope: Readonly<{
    applicationId?: string;
    workspaceId?: string;
    snapshotVersion?: number;
    occurredAtEpochMs?: number;
  }> = {},
): ClientEvent {
  return {
    applicationId: scope.applicationId ?? 'app-1',
    workspaceId: scope.workspaceId ?? 'workspace-1',
    principalId,
    eventId,
    eventType,
    clientInstanceId: `${principalId}-instance`,
    sessionId: `${principalId}-session`,
    snapshotVersion: scope.snapshotVersion ?? 1,
    occurredAtEpochMs: scope.occurredAtEpochMs ?? 1,
    actor: {
      kind: 'session',
      principalId,
      sessionId: `${principalId}-session`,
    },
    reason: null,
    traceId: null,
    requestId: `request-${eventId}`,
    payload: {},
  };
}

export function createPeopleEventPage(
  events: readonly ClientEvent[],
  hasMore: boolean,
): StateEventPage<ClientEvent> {
  const last = events.at(-1);
  return {
    events,
    nextCursor: last
      ? {
          snapshotVersion: last.snapshotVersion,
          occurredAtEpochMs: last.occurredAtEpochMs,
          eventId: last.eventId,
        }
      : undefined,
    hasMore,
  };
}

export function createPeopleSnapshot(principalId: string, sessionId: string): ClientSnapshot {
  const snapshot = createClientSnapshotFixture({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    principalId,
  });
  return {
    ...snapshot,
    activeSessions: [
      createActiveClientSessionFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId,
        clientInstanceId: `${principalId}-instance`,
        sessionId,
      }),
    ],
    isOnline: true,
    activeSessionCount: 1,
    lastSeenAtEpochMs: 1,
  };
}

export function createPeopleRoomSnapshot(
  groupId: string,
  sessionIds: readonly string[],
): GroupSnapshot {
  return createGroupSnapshotFixture({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId,
    sessionIds,
  });
}

export function toRoomEventMessage(event: GroupEvent) {
  return newALBroadcastMessage(
    'server-1',
    newALEventRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
    'all',
    AppTopics.groupStateEvent,
    event,
  );
}
