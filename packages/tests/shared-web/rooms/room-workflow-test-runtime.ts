import { vi } from 'vitest';

import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const roomWorkflowMocks = await vi.hoisted(async () => {
  const { createApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
  const ctx = createApiMiddlewareTestDouble();
  const operationLog: string[] = [];
  const groupSnapshots: GroupSnapshot[] = [];

  return {
    operationLog,
    groupSnapshots,
    cacheListeners: new Set<() => void | Promise<void>>(),
    session: ctx.session,
    ctx,
    clearMiddleware: vi.fn(),
    initMiddleware: vi.fn(async (): Promise<ApiMiddleware> => ctx),
    isMiddlewareReady: vi.fn(() => false),
    createAndJoinStateGroup: vi.fn(),
    joinStateGroup: vi.fn(),
    leaveStateGroup: vi.fn(),
    updateStateGroupDetails: vi.fn(),
    updateStateGroupMetadata: vi.fn(),
    archiveStateGroup: vi.fn(),
    deleteStateGroup: vi.fn(),
    createStateGroupInvite: vi.fn(),
    acceptStateGroupInvite: vi.fn(),
    removeStateGroupMember: vi.fn(),
    banStateGroupMember: vi.fn(),
    unbanStateGroupMember: vi.fn(),
    setStateGroupMemberRole: vi.fn(),
    transferStateGroupOwnership: vi.fn(),
    hydrateStateCaches: vi.fn(),
    onStateCacheChange: vi.fn(),
    readSession: vi.fn(() => ctx.session),
  };
});

vi.mock(import('@shared-web/browser/app-context.ts'), () => ({
  clearMiddleware: roomWorkflowMocks.clearMiddleware,
  getMiddleware: vi.fn(() => roomWorkflowMocks.ctx),
  initMiddleware: roomWorkflowMocks.initMiddleware,
  isMiddlewareReady: roomWorkflowMocks.isMiddlewareReady,
}));

vi.mock(import('@shared-web/browser/api-workflows.ts'), () => ({
  createAndJoinStateGroup: roomWorkflowMocks.createAndJoinStateGroup,
  joinStateGroup: roomWorkflowMocks.joinStateGroup,
  leaveStateGroup: roomWorkflowMocks.leaveStateGroup,
}));

vi.mock(import('@shared-web/browser/rooms/room-group-state-workflows.ts'), () => ({
  createAndJoinStateGroup: roomWorkflowMocks.createAndJoinStateGroup,
  joinStateGroup: roomWorkflowMocks.joinStateGroup,
  leaveStateGroup: roomWorkflowMocks.leaveStateGroup,
}));

vi.mock(import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'), () => ({
  updateStateGroupDetails: roomWorkflowMocks.updateStateGroupDetails,
  updateStateGroupMetadata: roomWorkflowMocks.updateStateGroupMetadata,
  archiveStateGroup: roomWorkflowMocks.archiveStateGroup,
  deleteStateGroup: roomWorkflowMocks.deleteStateGroup,
}));

vi.mock(import('@shared-web/browser/rooms/room-membership-group-state-workflows.ts'), () => ({
  createStateGroupInvite: roomWorkflowMocks.createStateGroupInvite,
  acceptStateGroupInvite: roomWorkflowMocks.acceptStateGroupInvite,
  removeStateGroupMember: roomWorkflowMocks.removeStateGroupMember,
  banStateGroupMember: roomWorkflowMocks.banStateGroupMember,
  unbanStateGroupMember: roomWorkflowMocks.unbanStateGroupMember,
  setStateGroupMemberRole: roomWorkflowMocks.setStateGroupMemberRole,
  transferStateGroupOwnership: roomWorkflowMocks.transferStateGroupOwnership,
}));

vi.mock(import('@shared-web/browser/data-caches.ts'), () => ({
  hydrateStateCaches: roomWorkflowMocks.hydrateStateCaches,
  onStateCacheChange: roomWorkflowMocks.onStateCacheChange,
}));

vi.mock(import('@shared/api/auth.ts'), () => ({
  clearSession: vi.fn(),
  isLoggedIn: vi.fn(() => true),
  readSession: roomWorkflowMocks.readSession,
  writeSession: vi.fn(),
}));

vi.mock(import('@shared/repository/client-state-snapshots-repository.ts'), () => ({
  findClientStateSnapshotByPrincipalId: vi.fn(),
  getAllClientStateSnapshots: vi.fn(() => []),
}));

vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), () => ({
  findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn(
    (sessionId: string) =>
      roomWorkflowMocks.groupSnapshots.find((snapshot) =>
        snapshot.activeSessions.some((session) => session.sessionId === sessionId),
      )?.group,
  ),
  findGroupStateSnapshotByRef: vi.fn((roomRef: GroupRef) =>
    roomWorkflowMocks.groupSnapshots.find((snapshot) => isSameRoomRef(snapshot.group, roomRef)),
  ),
  getAllGroupStateSnapshots: vi.fn(() => [...roomWorkflowMocks.groupSnapshots]),
  removeGroupStateSnapshotIfUnchanged: vi.fn((roomRef: GroupRef, expected: GroupSnapshot) => {
    const index = roomWorkflowMocks.groupSnapshots.findIndex(
      (snapshot) => snapshot === expected && isSameRoomRef(snapshot.group, roomRef),
    );
    if (index < 0) return false;
    roomWorkflowMocks.groupSnapshots.splice(index, 1);
    return true;
  }),
  waitForGroupStateSnapshotChangesIdle: vi.fn(async () => undefined),
}));

export function readRoomWorkflowMocks(): typeof roomWorkflowMocks {
  return roomWorkflowMocks;
}

export function resetRoomWorkflowTestRuntime(): void {
  vi.clearAllMocks();
  vi.useRealTimers();
  roomWorkflowMocks.operationLog.length = 0;
  roomWorkflowMocks.groupSnapshots.length = 0;
  roomWorkflowMocks.cacheListeners.clear();
  roomWorkflowMocks.readSession.mockReturnValue(roomWorkflowMocks.session);
  roomWorkflowMocks.initMiddleware.mockResolvedValue(roomWorkflowMocks.ctx);
  roomWorkflowMocks.isMiddlewareReady.mockReturnValue(false);
  roomWorkflowMocks.createAndJoinStateGroup.mockImplementation(async (displayName) => {
    roomWorkflowMocks.operationLog.push(`create:${String(displayName)}`);
    throw new Error('create not mocked');
  });
  roomWorkflowMocks.joinStateGroup.mockImplementation(async (roomId) => {
    roomWorkflowMocks.operationLog.push(`join:${String(roomId)}`);
    throw new Error('join not mocked');
  });
  roomWorkflowMocks.leaveStateGroup.mockImplementation(async (roomId) => {
    roomWorkflowMocks.operationLog.push(`leave:${String(roomId)}`);
    throw new Error('leave not mocked');
  });
  roomWorkflowMocks.updateStateGroupDetails.mockImplementation(async () => {
    throw new Error('update not mocked');
  });
  roomWorkflowMocks.updateStateGroupMetadata.mockImplementation(async () => {
    throw new Error('metadata update not mocked');
  });
  roomWorkflowMocks.archiveStateGroup.mockImplementation(async () => {
    throw new Error('archive not mocked');
  });
  roomWorkflowMocks.deleteStateGroup.mockImplementation(async () => {
    throw new Error('delete not mocked');
  });
  roomWorkflowMocks.createStateGroupInvite.mockImplementation(async () => {
    throw new Error('invite not mocked');
  });
  roomWorkflowMocks.acceptStateGroupInvite.mockImplementation(async () => {
    throw new Error('accept invite not mocked');
  });
  roomWorkflowMocks.removeStateGroupMember.mockImplementation(async () => {
    throw new Error('remove member not mocked');
  });
  roomWorkflowMocks.banStateGroupMember.mockImplementation(async () => {
    throw new Error('ban member not mocked');
  });
  roomWorkflowMocks.unbanStateGroupMember.mockImplementation(async () => {
    throw new Error('unban member not mocked');
  });
  roomWorkflowMocks.setStateGroupMemberRole.mockImplementation(async () => {
    throw new Error('set role not mocked');
  });
  roomWorkflowMocks.transferStateGroupOwnership.mockImplementation(async () => {
    throw new Error('transfer ownership not mocked');
  });
  roomWorkflowMocks.hydrateStateCaches.mockImplementation(
    async (_manager, _client, _clients, groups: readonly GroupSnapshot[]) => {
      roomWorkflowMocks.operationLog.push(
        `hydrate:${groups.map((snapshot) => snapshot.group.groupId).join(',')}`,
      );
      upsertGroupSnapshots(groups);
      await notifyCacheListeners();
    },
  );
  roomWorkflowMocks.onStateCacheChange.mockImplementation((listener) => {
    roomWorkflowMocks.cacheListeners.add(listener);
    return () => {
      roomWorkflowMocks.cacheListeners.delete(listener);
    };
  });
}

export function createRoomSnapshot(
  groupId: string,
  sessionIds: readonly string[],
  scope: Readonly<{ applicationId?: string; workspaceId?: string }> = {},
): GroupSnapshot {
  return createGroupSnapshotFixture({
    applicationId: scope.applicationId ?? 'app-1',
    workspaceId: scope.workspaceId ?? 'workspace-1',
    groupId,
    sessionIds,
  });
}

export function seedRoomSnapshots(snapshots: readonly GroupSnapshot[]): void {
  roomWorkflowMocks.groupSnapshots.splice(0, Infinity, ...snapshots);
}

export function resolveCreateWith(snapshot: GroupSnapshot): void {
  roomWorkflowMocks.createAndJoinStateGroup.mockImplementation(async (displayName) => {
    roomWorkflowMocks.operationLog.push(`create:${String(displayName)}`);
    return snapshot;
  });
}

export function rejectCreateWith(error: Error): void {
  roomWorkflowMocks.createAndJoinStateGroup.mockImplementation(async (displayName) => {
    roomWorkflowMocks.operationLog.push(`create:${String(displayName)}`);
    throw error;
  });
}

export function resolveJoinWith(snapshot: GroupSnapshot): void {
  roomWorkflowMocks.joinStateGroup.mockImplementation(async (roomId) => {
    roomWorkflowMocks.operationLog.push(`join:${String(roomId)}`);
    return snapshot;
  });
}

export function rejectJoinWith(error: Error): void {
  roomWorkflowMocks.joinStateGroup.mockImplementation(async (roomId) => {
    roomWorkflowMocks.operationLog.push(`join:${String(roomId)}`);
    throw error;
  });
}

export function resolveLeaveWith(snapshot: GroupSnapshot): void {
  roomWorkflowMocks.leaveStateGroup.mockImplementation(async (roomId) => {
    roomWorkflowMocks.operationLog.push(`leave:${String(roomId)}`);
    return snapshot;
  });
}

export function rejectLeaveWith(error: Error): void {
  roomWorkflowMocks.leaveStateGroup.mockImplementation(async (roomId) => {
    roomWorkflowMocks.operationLog.push(`leave:${String(roomId)}`);
    throw error;
  });
}

export async function publishRoomSnapshots(snapshots: readonly GroupSnapshot[]): Promise<void> {
  seedRoomSnapshots(snapshots);
  await notifyCacheListeners();
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function upsertGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
  for (const snapshot of snapshots) {
    const index = roomWorkflowMocks.groupSnapshots.findIndex((candidate) =>
      isSameRoomRef(candidate.group, snapshot.group),
    );
    if (index < 0) {
      roomWorkflowMocks.groupSnapshots.push(snapshot);
    } else {
      roomWorkflowMocks.groupSnapshots[index] = snapshot;
    }
  }
}

async function notifyCacheListeners(): Promise<void> {
  await Promise.all(
    [...roomWorkflowMocks.cacheListeners].map(async (listener) => await listener()),
  );
}

function isSameRoomRef(left: GroupRef, right: GroupRef): boolean {
  return (
    left.applicationId === right.applicationId &&
    (left.workspaceId ?? '') === (right.workspaceId ?? '') &&
    left.groupId === right.groupId
  );
}
