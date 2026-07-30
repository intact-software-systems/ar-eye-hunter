import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const mocks = vi.hoisted(() => {
  const session = {
    clientId: 'principal-1',
    sessionId: 'session-1',
    username: 'principal-1',
    accessToken: 'token-1',
    expiresAtEpochMs: Date.now() + 60_000,
  };
  const realtimeChannel = {
    sendJson: vi.fn(),
    sendBinary: vi.fn(),
    readHealth: vi.fn(() => ({
      label: 'realtime',
      readyState: 'open',
      bufferedAmount: 0,
      sent: 0,
      queued: 0,
      replaced: 0,
      closed: 0,
      flushed: 0,
      droppedOldest: 0,
      droppedStale: 0,
      receivedRaw: 0,
      receivedString: 0,
      receivedBinary: 0,
    })),
  };
  const webRtcConnectionService = {
    peerIdsWithNoReconnectableLanes: vi.fn((): readonly string[] => []),
    knownPeerIds: vi.fn((): readonly string[] => []),
    activePeerIds: vi.fn((): readonly string[] => []),
    readyPeerIdsForLane: vi.fn((_laneId?: string): readonly string[] => []),
    ensurePeerConnectionStarted: vi.fn((_peerId: string) => ({
      left: {
        kind: 'connect-failed',
        peerId: _peerId,
        error: new Error('connect not mocked'),
      },
    })),
    ensurePeerLaneOpen: vi.fn(async (peerId: string, laneId: string) => ({
      status: 'open',
      peerId,
      laneId,
      channel: realtimeChannel,
    })),
    disconnectPeer: vi.fn(() => true),
    onRtcPeerLifecycleDo: vi.fn(),
    readPeer: vi.fn(),
    removeRtcPeerLifecycleById: vi.fn(() => true),
  };
  webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() => webRtcConnectionService);
  const ctx = {
    session,
    authFetch: vi.fn(),
    middleware: {
      qboxEngine: {
        wake: vi.fn(),
        stop: vi.fn(),
      },
      rtcRxStreamer: {
        enqueueOutboxIfAbsent: vi.fn(),
        onInboxMessageDo: vi.fn(),
        removeInboxMessageCallback: vi.fn(() => true),
        stopAllHeartbeats: vi.fn(),
      },
      webRtcGroupManager: {},
      webRtcConnectionService,
      heartbeat: {
        stop: vi.fn(),
      },
      webSocketQueueBox: {
        enqueueOutboxIfAbsent: vi.fn(),
        readHealth: vi.fn(() => ({
          sessionId: session.sessionId,
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
      },
    },
  } as unknown as ApiMiddleware;

  return {
    ctx,
    hydrateStateCaches: vi.fn(() => Promise.resolve()),
    initMiddleware: vi.fn((_options?: unknown) => Promise.resolve(ctx)),
    isMiddlewareReady: vi.fn(() => false),
    onStateCacheChange: vi.fn(() => vi.fn()),
    readSession: vi.fn(() => session),
    groupRepositoryMissing: vi.fn((_value?: unknown): unknown => {
      throw new Error('Repository not found: shared.repository.group-state-snapshots');
    }),
    clientRepositoryMissing: vi.fn((_value?: unknown): unknown => {
      throw new Error('Repository not found: shared.repository.client-state-snapshots');
    }),
    realtimeChannel,
    webRtcConnectionService,
  };
});

vi.mock('@shared-web/browser/app-context.ts', () => ({
  clearMiddleware: vi.fn(),
  getMiddleware: vi.fn(() => mocks.ctx),
  initMiddleware: mocks.initMiddleware,
  isMiddlewareReady: mocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
  hydrateStateCaches: mocks.hydrateStateCaches,
  onStateCacheChange: mocks.onStateCacheChange,
}));

vi.mock('@shared/api/auth.ts', () => ({
  clearSession: vi.fn(),
  isLoggedIn: vi.fn(() => true),
  readSession: mocks.readSession,
  writeSession: vi.fn(),
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
  findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
  getAllClientStateSnapshots: mocks.clientRepositoryMissing,
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
  findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.groupRepositoryMissing,
  findGroupStateSnapshotByRef: mocks.groupRepositoryMissing,
  getAllGroupStateSnapshots: mocks.groupRepositoryMissing,
}));

describe('Rallar room realtime channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hydrateStateCaches.mockResolvedValue(undefined);
    mocks.initMiddleware.mockResolvedValue(mocks.ctx);
    mocks.isMiddlewareReady.mockReturnValue(false);
    mocks.readSession.mockReturnValue(mocks.ctx.session);
    mocks.groupRepositoryMissing.mockImplementation(() => {
      throw new Error('Repository not found: shared.repository.group-state-snapshots');
    });
    mocks.clientRepositoryMissing.mockImplementation(() => {
      throw new Error('Repository not found: shared.repository.client-state-snapshots');
    });
    mocks.realtimeChannel.sendJson.mockReturnValue({
      status: 'sent',
      bufferedAmount: 0,
    });
    mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
    mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
    mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
    mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
      async (peerId: string, laneId: string) => ({
        status: 'open',
        peerId,
        laneId,
        channel: mocks.realtimeChannel,
      }),
    );
  });

  it('waits for a room lane and sends JSON only to ready room peers', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-ready', 'peer-slow']));
    mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
      async (peerId: string, laneId: string) => ({
        status: peerId === 'peer-ready' ? 'open' : 'timeout',
        peerId,
        laneId,
        channel: peerId === 'peer-ready' ? mocks.realtimeChannel : undefined,
        error: peerId === 'peer-ready' ? undefined : new Error('timeout'),
      }),
    );

    const result = await createRallarFacade()
      .realtime.room<{ x: number }>({
        roomId: 'room-1',
        laneId: 'motion',
        waitTimeoutMs: 100,
        openTimeoutMs: 25,
      })
      .send(
        { x: 1 },
        {
          key: 'motion:peer-ready',
          maxAgeMs: 120,
        },
      );

    expect(result.status).toBe('partial');
    expect(result.peerIds).toEqual(['peer-ready']);
    expect(result.readiness?.status).toBe('partial');
    expect(mocks.realtimeChannel.sendJson).toHaveBeenCalledWith(
      { x: 1 },
      expect.objectContaining({
        key: 'motion:peer-ready',
        maxAgeMs: 120,
      }),
    );
    expect(mocks.webRtcConnectionService.ensurePeerLaneOpen).toHaveBeenCalledWith(
      'peer-ready',
      'motion',
      expect.objectContaining({ timeoutMs: 100 }),
    );
  });

  it('does not send when a room lane has no ready peers after waiting', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-slow']));
    mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
      status: 'timeout',
      peerId: 'peer-slow',
      laneId: 'motion',
      error: new Error('timeout'),
    });

    const result = await createRallarFacade()
      .realtime.room<{ x: number }>({
        roomId: 'room-1',
        laneId: 'motion',
        waitTimeoutMs: 100,
      })
      .send({ x: 1 });

    expect(result.status).toBe('not-ready');
    expect(result.peerIds).toEqual([]);
    expect(result.readiness?.status).toBe('timeout');
    expect(mocks.realtimeChannel.sendJson).not.toHaveBeenCalled();
  });

  it('does not open or send room realtime for a room the current session has not joined', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    mockGroupSnapshot(createGroupSnapshot('room-1', ['peer-ready']));

    const result = await createRallarFacade()
      .realtime.room<{ x: number }>({
        roomId: 'room-1',
        laneId: 'motion',
        waitTimeoutMs: 100,
      })
      .send({ x: 1 });

    expect(result.status).toBe('no-targets');
    expect(result.peerIds).toEqual([]);
    expect(result.desiredPeerIds).toEqual([]);
    expect(mocks.webRtcConnectionService.ensurePeerLaneOpen).not.toHaveBeenCalled();
    expect(mocks.realtimeChannel.sendJson).not.toHaveBeenCalled();
  });

  it('uses already-ready room peers without a readiness wait', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-ready']));
    mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-ready']);
    mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-ready']);
    mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-ready']);

    const result = await createRallarFacade()
      .realtime.room<{ x: number }>({
        roomId: 'room-1',
        laneId: 'motion',
        waitTimeoutMs: 100,
      })
      .send({ x: 1 });

    expect(result.status).toBe('sent');
    expect(result.readiness).toBeUndefined();
    expect(mocks.webRtcConnectionService.ensurePeerLaneOpen).toHaveBeenCalledTimes(1);
    expect(mocks.realtimeChannel.sendJson).toHaveBeenCalledOnce();
  });
});

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
  mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
  mocks.groupRepositoryMissing.mockImplementation((key?: unknown) => {
    if (key === undefined) {
      return [...snapshots];
    }

    if (isGroupRefLike(key)) {
      return snapshots.find(
        (snapshot) =>
          snapshot.group.groupId === key.groupId &&
          snapshot.group.applicationId === key.applicationId &&
          (snapshot.group.workspaceId ?? '') === (key.workspaceId ?? ''),
      );
    }

    return snapshots.find((snapshot) => key === snapshot.group.groupId);
  });
}

function isGroupRefLike(value: unknown): value is GroupSnapshot['group'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { groupId?: unknown }).groupId === 'string' &&
    typeof (value as { applicationId?: unknown }).applicationId === 'string'
  );
}

function createGroupSnapshot(groupId: string, sessionIds: readonly string[]): GroupSnapshot {
  const applicationId = 'app-1';
  const workspaceId = 'workspace-1';
  return createGroupSnapshotFixture({
    applicationId,
    workspaceId,
    groupId,
    sessionIds,
  });
}
