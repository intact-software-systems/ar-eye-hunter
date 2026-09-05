import { vi } from 'vitest';

import type { ApiMiddleware, RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { StateCacheChangeListener } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');
type RoomGroupStateMutationWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts');
type RoomMembershipGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-membership-group-state-workflows.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');

interface RoomSnapshotScopeFixture {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const roomWorkflowMocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    const ctx = createDefaultApiMiddlewareTestDouble();
    const operationLog: string[] = [];
    const groupSnapshots: GroupSnapshot[] = [];

    return {
        operationLog,
        groupSnapshots,
        cacheListeners: new Set<StateCacheChangeListener>(),
        session: ctx.session,
        ctx,
        initialiseApiMiddleware: vi.fn(async (): Promise<ApiMiddleware> => ctx),
        createAndJoinStateGroup: vi.fn<RoomGroupStateWorkflowsModule['createAndJoinStateGroup']>(),
        joinStateGroup: vi.fn<RoomGroupStateWorkflowsModule['joinStateGroup']>(),
        leaveStateGroup: vi.fn<RoomGroupStateWorkflowsModule['leaveStateGroup']>(),
        updateStateGroupDetails: vi.fn<RoomGroupStateMutationWorkflowsModule['updateStateGroupDetails']>(),
        updateStateGroupMetadata: vi.fn<RoomGroupStateMutationWorkflowsModule['updateStateGroupMetadata']>(),
        archiveStateGroup: vi.fn<RoomGroupStateMutationWorkflowsModule['archiveStateGroup']>(),
        deleteStateGroup: vi.fn<RoomGroupStateMutationWorkflowsModule['deleteStateGroup']>(),
        createStateGroupInvite: vi.fn<RoomMembershipGroupStateWorkflowsModule['createStateGroupInvite']>(),
        acceptStateGroupInvite: vi.fn<RoomMembershipGroupStateWorkflowsModule['acceptStateGroupInvite']>(),
        removeStateGroupMember: vi.fn<RoomMembershipGroupStateWorkflowsModule['removeStateGroupMember']>(),
        banStateGroupMember: vi.fn<RoomMembershipGroupStateWorkflowsModule['banStateGroupMember']>(),
        unbanStateGroupMember: vi.fn<RoomMembershipGroupStateWorkflowsModule['unbanStateGroupMember']>(),
        setStateGroupMemberRole: vi.fn<RoomMembershipGroupStateWorkflowsModule['setStateGroupMemberRole']>(),
        transferStateGroupOwnership: vi.fn<RoomMembershipGroupStateWorkflowsModule['transferStateGroupOwnership']>(),
        hydrateStateCache: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['hydrate']>(),
        onCacheChange: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['onChange']>(),
        readSession: vi.fn(() => ctx.session)
    };
});

vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), () => ({
    initialiseMiddleware: async (): Promise<RallarBrowserMiddleware> => roomWorkflowMocks.ctx.middleware
}));

vi.mock(import('@shared-web/browser/rooms/room-group-state-workflows.ts'), () => ({
    createAndJoinStateGroup: roomWorkflowMocks.createAndJoinStateGroup,
    joinStateGroup: roomWorkflowMocks.joinStateGroup,
    leaveStateGroup: roomWorkflowMocks.leaveStateGroup
}));

vi.mock(import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'), () => ({
    updateStateGroupDetails: roomWorkflowMocks.updateStateGroupDetails,
    updateStateGroupMetadata: roomWorkflowMocks.updateStateGroupMetadata,
    archiveStateGroup: roomWorkflowMocks.archiveStateGroup,
    deleteStateGroup: roomWorkflowMocks.deleteStateGroup
}));

vi.mock(import('@shared-web/browser/rooms/room-membership-group-state-workflows.ts'), () => ({
    createStateGroupInvite: roomWorkflowMocks.createStateGroupInvite,
    acceptStateGroupInvite: roomWorkflowMocks.acceptStateGroupInvite,
    removeStateGroupMember: roomWorkflowMocks.removeStateGroupMember,
    banStateGroupMember: roomWorkflowMocks.banStateGroupMember,
    unbanStateGroupMember: roomWorkflowMocks.unbanStateGroupMember,
    setStateGroupMemberRole: roomWorkflowMocks.setStateGroupMemberRole,
    transferStateGroupOwnership: roomWorkflowMocks.transferStateGroupOwnership
}));

vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), () => ({
    browserStateCacheLifecycle: {
        hydrate: roomWorkflowMocks.hydrateStateCache,
        onChange: roomWorkflowMocks.onCacheChange,
        initialise: vi.fn(),
        cancelSnapshotAssemblies: vi.fn(() => undefined)
    }
}));

vi.mock(import('@shared/api/auth.ts'), () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: roomWorkflowMocks.readSession,
    writeSession: vi.fn()
}));

vi.mock(import('@shared/repository/client-state-snapshots-repository.ts'), () => ({
    findClientStateSnapshotByPrincipalId: vi.fn(),
    getAllClientStateSnapshots: vi.fn(() => [])
}));

vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn(
        (sessionId: string) =>
            roomWorkflowMocks.groupSnapshots.find((snapshot) => snapshot.activeSessions.some((session) => session.sessionId === sessionId))?.group
    ),
    findGroupStateSnapshotByRef: vi.fn((roomRef: GroupRef) => roomWorkflowMocks.groupSnapshots.find((snapshot) => isSameGroupRef(snapshot.group, roomRef))),
    getAllGroupStateSnapshots: vi.fn(() => [...roomWorkflowMocks.groupSnapshots]),
    removeGroupStateSnapshotIfUnchanged: vi.fn((roomRef: GroupRef, expected: GroupSnapshot) => {
        const index = roomWorkflowMocks.groupSnapshots.findIndex(
            (snapshot) => snapshot === expected && isSameGroupRef(snapshot.group, roomRef)
        );
        if (index < 0) {
            return false;
        }
        roomWorkflowMocks.groupSnapshots.splice(index, 1);
        return true;
    }),
    waitForGroupStateSnapshotChangesIdle: vi.fn(async () => undefined)
}));

vi.mock(import('@shared/repository/overlays-repository.ts'), async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        findPlannedOverlayById: vi.fn(),
        findAcceptedOverlayById: vi.fn(),
        removePlannedOverlayByIdIfUnchanged: vi.fn(() => false),
        removeAcceptedOverlayByIdIfUnchanged: vi.fn(() => false),
        waitForPlannedOverlayChangesIdle: vi.fn(async () => undefined),
        waitForAcceptedOverlayChangesIdle: vi.fn(async () => undefined)
    };
});

export function readRoomWorkflowMocks(): typeof roomWorkflowMocks {
    return roomWorkflowMocks;
}

export function resetRoomWorkflowTestRuntime(): void {
    vi.clearAllMocks();
    vi.useRealTimers();
    roomWorkflowMocks.operationLog.length = 0;
    roomWorkflowMocks.groupSnapshots.length = 0;
    roomWorkflowMocks.cacheListeners.clear();
    resetRoomWorkflowLifecycleMocks();
    resetRoomWorkflowEntryMocks();
    resetRoomWorkflowMutationMocks();
    resetRoomWorkflowCacheMocks();
}

function resetRoomWorkflowLifecycleMocks(): void {
    roomWorkflowMocks.readSession.mockReturnValue(roomWorkflowMocks.session);
    roomWorkflowMocks.initialiseApiMiddleware.mockResolvedValue(roomWorkflowMocks.ctx);
}

function resetRoomWorkflowEntryMocks(): void {
    roomWorkflowMocks.createAndJoinStateGroup.mockImplementation(async (input) => {
        roomWorkflowMocks.operationLog.push(`create:${input.displayName}`);
        throw new Error('create not mocked');
    });
    roomWorkflowMocks.joinStateGroup.mockImplementation(async (input) => {
        roomWorkflowMocks.operationLog.push(`join:${input.groupId}`);
        throw new Error('join not mocked');
    });
    roomWorkflowMocks.leaveStateGroup.mockImplementation(async (input) => {
        roomWorkflowMocks.operationLog.push(`leave:${input.groupId}`);
        throw new Error('leave not mocked');
    });
}

function resetRoomWorkflowMutationMocks(): void {
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
}

function resetRoomWorkflowCacheMocks(): void {
    roomWorkflowMocks.hydrateStateCache.mockImplementation(
        async (input) => {
            roomWorkflowMocks.operationLog.push(
                `hydrate:${input.groupSnapshots.map((snapshot) => snapshot.group.groupId).join(',')}`
            );
            upsertGroupSnapshots(input.groupSnapshots);
            await notifyCacheListeners(input.groupSnapshots);
        }
    );
    roomWorkflowMocks.onCacheChange.mockImplementation((listener) => {
        roomWorkflowMocks.cacheListeners.add(listener);
        return () => {
            roomWorkflowMocks.cacheListeners.delete(listener);
        };
    });
}

export function createRoomSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: RoomSnapshotScopeFixture = {}
): GroupSnapshot {
    return createGroupSnapshotFixture({
        applicationId: scope.applicationId ?? 'app-1',
        workspaceId: scope.workspaceId ?? 'workspace-1',
        groupId,
        sessionIds
    });
}

export function seedRoomSnapshots(snapshots: readonly GroupSnapshot[]): void {
    roomWorkflowMocks.groupSnapshots.splice(0, Infinity, ...snapshots);
}

export function resolveCreateWith(snapshot: GroupSnapshot): void {
    roomWorkflowMocks.createAndJoinStateGroup.mockImplementation(async (input) => {
        roomWorkflowMocks.operationLog.push(`create:${input.displayName}`);
        return snapshot;
    });
}

export function rejectCreateWith(error: Error): void {
    roomWorkflowMocks.createAndJoinStateGroup.mockImplementation(async (input) => {
        roomWorkflowMocks.operationLog.push(`create:${input.displayName}`);
        throw error;
    });
}

export function resolveJoinWith(snapshot: GroupSnapshot): void {
    roomWorkflowMocks.joinStateGroup.mockImplementation(async (input) => {
        roomWorkflowMocks.operationLog.push(`join:${input.groupId}`);
        return snapshot;
    });
}

export function rejectJoinWith(error: Error): void {
    roomWorkflowMocks.joinStateGroup.mockImplementation(async (input) => {
        roomWorkflowMocks.operationLog.push(`join:${input.groupId}`);
        throw error;
    });
}

export function resolveLeaveWith(snapshot: GroupSnapshot): void {
    roomWorkflowMocks.leaveStateGroup.mockImplementation(async (input) => {
        roomWorkflowMocks.operationLog.push(`leave:${input.groupId}`);
        return snapshot;
    });
}

export function rejectLeaveWith(error: Error): void {
    roomWorkflowMocks.leaveStateGroup.mockImplementation(async (input) => {
        roomWorkflowMocks.operationLog.push(`leave:${input.groupId}`);
        throw error;
    });
}

export async function publishRoomSnapshots(snapshots: readonly GroupSnapshot[]): Promise<void> {
    seedRoomSnapshots(snapshots);
    await notifyCacheListeners(snapshots);
}

function upsertGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    for (const snapshot of snapshots) {
        const index = roomWorkflowMocks.groupSnapshots.findIndex((candidate) => isSameGroupRef(candidate.group, snapshot.group));
        if (index < 0) {
            roomWorkflowMocks.groupSnapshots.push(snapshot);
        }
        else {
            roomWorkflowMocks.groupSnapshots[index] = snapshot;
        }
    }
}

async function notifyCacheListeners(groups: readonly GroupSnapshot[]): Promise<void> {
    await Promise.all(
        [...roomWorkflowMocks.cacheListeners].map(async (listener) =>
            await listener({
                clients: [],
                groups
            })
        )
    );
}
