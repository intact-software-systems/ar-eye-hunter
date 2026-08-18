import { vi } from 'vitest';

import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { createRoomEvents } from '@shared-web/browser/rooms/room-events.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';

const roomEventMocks = await vi.hoisted(async () => {
  const { createApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
  const ctx = createApiMiddlewareTestDouble();

  return {
    session: ctx.session,
    ctx,
    hydrateStateCaches: vi.fn(async (): Promise<void> => undefined),
    initMiddleware: vi.fn(async (): Promise<ApiMiddleware> => ctx),
    isMiddlewareReady: vi.fn(() => false),
    listStateGroupEvents: vi.fn(async (_groupId: string): Promise<GroupEvent[]> => []),
    listStateGroupEventPage: vi.fn(
      async (_groupId: string): Promise<StateEventPage<GroupEvent>> => ({
        events: [],
        hasMore: false,
      }),
    ),
    groupRepositoryMissing: vi.fn((): never => {
      throw new Error('Repository not found: shared.repository.group-state-snapshots');
    }),
  };
});

void createRoomEvents;

vi.mock(import('@shared-web/browser/app-context.ts'), () => ({
  clearMiddleware: vi.fn(),
  getMiddleware: vi.fn(() => roomEventMocks.ctx),
  initMiddleware: roomEventMocks.initMiddleware,
  isMiddlewareReady: roomEventMocks.isMiddlewareReady,
}));

vi.mock(import('@shared-web/browser/api-integration.ts'), () => ({
  listStateClientEventPage: vi.fn(),
  listStateClientEvents: vi.fn(),
  listStateGroupEventPage: roomEventMocks.listStateGroupEventPage,
  listStateGroupEvents: roomEventMocks.listStateGroupEvents,
}));

vi.mock(import('@shared-web/browser/api-workflows.ts'), () => ({
  refreshStateSnapshots: vi.fn(async () => ({ clients: [], groups: [] })),
}));

vi.mock(import('@shared-web/browser/data-caches.ts'), () => ({
  hydrateStateCaches: roomEventMocks.hydrateStateCaches,
  onStateCacheChange: vi.fn(() => vi.fn()),
}));

vi.mock(import('@shared/api/auth.ts'), () => ({
  clearSession: vi.fn(),
  isLoggedIn: vi.fn(() => true),
  readSession: vi.fn(() => roomEventMocks.session),
  writeSession: vi.fn(),
}));

vi.mock(import('@shared/repository/client-state-snapshots-repository.ts'), () => ({
  findClientStateSnapshotByPrincipalId: vi.fn(),
  getAllClientStateSnapshots: vi.fn(() => []),
}));

vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), () => ({
  findFirstGroupStateSnapshotRefSessionIdIsIn: roomEventMocks.groupRepositoryMissing,
  findGroupStateSnapshotByRef: roomEventMocks.groupRepositoryMissing,
  getAllGroupStateSnapshots: roomEventMocks.groupRepositoryMissing,
}));

export function readRoomEventMocks(): typeof roomEventMocks {
  return roomEventMocks;
}

export function resetRoomEventTestRuntime(): void {
  vi.clearAllMocks();
  roomEventMocks.hydrateStateCaches.mockResolvedValue(undefined);
  roomEventMocks.initMiddleware.mockResolvedValue(roomEventMocks.ctx);
  roomEventMocks.isMiddlewareReady.mockReturnValue(false);
  roomEventMocks.listStateGroupEvents.mockRejectedValue(new Error('group events not mocked'));
  roomEventMocks.listStateGroupEventPage.mockRejectedValue(
    new Error('group event page not mocked'),
  );
  roomEventMocks.groupRepositoryMissing.mockImplementation(() => {
    throw new Error('Repository not found: shared.repository.group-state-snapshots');
  });
  const { webSocketQueueBox, webRtcConnectionService } = roomEventMocks.ctx.middleware;
  vi.mocked(webSocketQueueBox.close).mockImplementation((code, reason) => {
    webSocketQueueBox.socket.close(code, reason);
  });
  vi.mocked(webSocketQueueBox.onAnyInboxMessageDo).mockReturnValue(webSocketQueueBox);
  vi.mocked(webSocketQueueBox.removeAnyInboxMessageCallback).mockReturnValue(true);
  vi.mocked(webRtcConnectionService.onRtcPeerLifecycleDo).mockReturnValue(webRtcConnectionService);
}

export function findRoomWsCallback(
  latest = false,
): { onMessage?: (message: unknown) => Promise<void> } | undefined {
  const calls = vi
    .mocked(roomEventMocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo)
    .mock.calls.filter(([callbackId]) => callbackId === 'rallar:ws:any-message');
  const call = latest ? calls.at(-1) : calls[0];
  return call?.[1] as { onMessage?: (message: unknown) => Promise<void> } | undefined;
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

// Mirrors the dual-emit wire form: the `group-state.event` row payload is a
// GroupStateDeltaEnvelope wrapping the GroupEvent instead of the bare event.
// Room dispatch unwraps on the wrapper discriminants plus the validated
// wrapped event, so the state-slice fields stay minimal here.
export function toRoomEventEnvelopeMessage(event: GroupEvent) {
  return newALBroadcastMessage(
    'server-1',
    newALEventRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
    'all',
    AppTopics.groupStateEvent,
    {
      event,
      predecessorCausalRevision: { groupRevision: 1, presenceRevision: 0 },
      resultingCausalRevision: event.causalRevision,
      members: [],
      removedMemberPrincipalIds: [],
      sessions: [],
      removedSessionIds: [],
      activeSessionIds: [],
      memberCount: 0,
      onlineMemberCount: 0,
      audienceSessionIds: [],
    },
  );
}

export function createRoomEvent(
  groupId: string,
  eventId: string,
  eventType: GroupEvent['eventType'],
  scope: Readonly<{
    applicationId?: string;
    workspaceId?: string;
    snapshotVersion?: number;
    occurredAtEpochMs?: number;
  }> = {},
): GroupEvent {
  return {
    applicationId: scope.applicationId ?? 'app-1',
    workspaceId: scope.workspaceId ?? 'workspace-1',
    groupId,
    eventId,
    eventType,
    snapshotVersion: scope.snapshotVersion ?? 1,
    causalRevision: { groupRevision: 1, presenceRevision: 1 },
    occurredAtEpochMs: scope.occurredAtEpochMs ?? 1,
    actor: { kind: 'session', principalId: 'alice', sessionId: 'session-1' },
    reason: null,
    traceId: null,
    requestId: `request-${eventId}`,
    payload: {},
  };
}

export function createRoomEventPage(
  events: readonly GroupEvent[],
  hasMore: boolean,
): StateEventPage<GroupEvent> {
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
