import { vi } from 'vitest';

import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { createRoomEvents } from '@shared-web/browser/rooms/room-events.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';

function createRoomEventSession() {
  return {
    clientId: 'principal-1',
    sessionId: 'session-1',
    username: 'principal-1',
    accessToken: 'token-1',
    expiresAtEpochMs: Date.now() + 60_000,
  };
}

function createRoomEventWebSocketQueueBox(sessionId: string) {
  return {
    enqueueOutboxIfAbsent: vi.fn(async () => ({ status: 'enqueued', entries: [] })),
    readHealth: vi.fn(() => ({
      sessionId,
      url: 'ws://localhost/ws',
      readyState: 'missing',
      isOpen: false,
      reconnecting: false,
      reconnectEnabled: false,
      reconnectAttempts: 0,
      maxReconnectAttempts: 12,
      reconnectExhausted: false,
    })),
    close: vi.fn(),
    onAnyInboxMessageDo: vi.fn(),
    removeAnyInboxMessageCallback: vi.fn(() => true),
    socket: {
      close: vi.fn(),
      onWebsocketCallbacksDo: vi.fn(),
      removeWebsocketCallbackById: vi.fn(() => true),
    },
  };
}

function createRoomEventMiddleware(
  session: ReturnType<typeof createRoomEventSession>,
  webSocketQueueBox: ReturnType<typeof createRoomEventWebSocketQueueBox>,
): ApiMiddleware {
  return {
    session,
    authFetch: vi.fn(),
    middleware: {
      qboxEngine: { wake: vi.fn(), stop: vi.fn() },
      rtcRxStreamer: {
        enqueueOutboxIfAbsent: vi.fn(async () => ({ status: 'enqueued', entries: [] })),
        onInboxMessageDo: vi.fn(),
        removeInboxMessageCallback: vi.fn(() => true),
        stopLocalMedia: vi.fn(),
        stopAllHeartbeats: vi.fn(),
      },
      webRtcGroupManager: {},
      webRtcConnectionService: {
        knownPeerIds: vi.fn((): readonly string[] => []),
        activePeerIds: vi.fn((): readonly string[] => []),
        disconnectPeer: vi.fn(() => true),
        onRtcPeerLifecycleDo: vi.fn(),
        removeRtcPeerLifecycleById: vi.fn(() => true),
      },
      heartbeat: { stop: vi.fn() },
      webSocketQueueBox,
    },
  } as unknown as ApiMiddleware;
}

function createRoomEventMocks() {
  const session = createRoomEventSession();
  const ctx = createRoomEventMiddleware(
    session,
    createRoomEventWebSocketQueueBox(session.sessionId),
  );

  return {
    session,
    ctx,
    hydrateStateCaches: vi.fn(async () => undefined),
    initMiddleware: vi.fn(async () => ctx),
    isMiddlewareReady: vi.fn(() => false),
    listStateGroupEvents: vi.fn(),
    listStateGroupEventPage: vi.fn(),
    groupRepositoryMissing: vi.fn(),
  };
}

const roomEventMocks = vi.hoisted(createRoomEventMocks);

void createRoomEvents;

vi.mock('@shared-web/browser/app-context.ts', () => ({
  clearMiddleware: vi.fn(),
  getMiddleware: vi.fn(() => roomEventMocks.ctx),
  initMiddleware: roomEventMocks.initMiddleware,
  isMiddlewareReady: roomEventMocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/api-integration.ts', () => ({
  listStateClientEventPage: vi.fn(),
  listStateClientEvents: vi.fn(),
  listStateGroupEventPage: roomEventMocks.listStateGroupEventPage,
  listStateGroupEvents: roomEventMocks.listStateGroupEvents,
}));

vi.mock('@shared-web/browser/api-workflows.ts', () => ({
  refreshStateSnapshots: vi.fn(async () => ({ clients: [], groups: [] })),
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
  hydrateStateCaches: roomEventMocks.hydrateStateCaches,
  onStateCacheChange: vi.fn(() => vi.fn()),
}));

vi.mock('@shared/api/auth.ts', () => ({
  clearSession: vi.fn(),
  isLoggedIn: vi.fn(() => true),
  readSession: vi.fn(() => roomEventMocks.session),
  writeSession: vi.fn(),
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
  findClientStateSnapshotByPrincipalId: vi.fn(),
  getAllClientStateSnapshots: vi.fn(() => []),
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
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
  roomEventMocks.ctx.middleware.webSocketQueueBox.close.mockImplementation(
    (code?: number, reason?: string) => {
      roomEventMocks.ctx.middleware.webSocketQueueBox.socket.close(code, reason);
    },
  );
  roomEventMocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
    roomEventMocks.ctx.middleware.webSocketQueueBox,
  );
  roomEventMocks.ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback.mockReturnValue(
    true,
  );
  roomEventMocks.ctx.middleware.webRtcConnectionService.onRtcPeerLifecycleDo.mockReturnValue(
    roomEventMocks.ctx.middleware.webRtcConnectionService,
  );
}

export function findRoomWsCallback(
  latest = false,
): { onMessage?: (message: unknown) => Promise<void> } | undefined {
  const calls =
    roomEventMocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo.mock.calls.filter(
      ([callbackId]) => callbackId === 'rallar:ws:any-message',
    );
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

export function createRoomEventPage(events: readonly GroupEvent[], hasMore: boolean) {
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
