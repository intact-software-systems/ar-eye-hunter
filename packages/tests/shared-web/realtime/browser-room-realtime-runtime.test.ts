import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type * as ClientStateSnapshotsRepositoryModule from '@shared/repository/client-state-snapshots-repository.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import { createNativeRealtimeLaneFixture } from './native-realtime-lane-fixture.ts';

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    const ctx = createDefaultApiMiddlewareTestDouble();
    return {
        ctx,
        hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(async () => {}),
        initialiseApiMiddleware: vi.fn<BrowserTransportRuntimePort['init']>(async () => ctx),
        onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
        readSession: vi.fn<typeof AuthModule.readSession>(() => ctx.session),
        findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(),
        getAllClientStateSnapshots: vi.fn<typeof ClientStateSnapshotsRepositoryModule.getAllClientStateSnapshots>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findFirstGroupStateSnapshotRefSessionIdIsIn>(),
        findGroupStateSnapshotByRef: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef>(),
        getAllGroupStateSnapshots: vi.fn<typeof GroupStateSnapshotsRepositoryModule.getAllGroupStateSnapshots>(() => [])
    };
});

const connection = vi.mocked(mocks.ctx.middleware.webRtcConnectionService);

vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), (): Partial<typeof MiddlewareModule> => ({
    initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
}));
vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), (): Partial<typeof StateCacheLifecycleModule> => ({
    browserStateCacheLifecycle: { hydrate: mocks.hydrateStateCache, onChange: mocks.onCacheChange, initialise: vi.fn() }
}));
vi.mock(import('@shared/api/auth.ts'), (): Partial<typeof AuthModule> => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn()
}));
vi.mock(import('@shared/repository/client-state-snapshots-repository.ts'), (): Partial<typeof ClientStateSnapshotsRepositoryModule> => ({
    findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
    getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
}));
vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), (): Partial<typeof GroupStateSnapshotsRepositoryModule> => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
    getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
}));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
    mocks.getAllClientStateSnapshots.mockReturnValue([]);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
    mocks.hydrateStateCache.mockResolvedValue(undefined);
    mocks.initialiseApiMiddleware.mockResolvedValue(mocks.ctx);
    mocks.readSession.mockReturnValue(mocks.ctx.session);
    connection.activePeerIds.mockReturnValue([]);
    connection.knownPeerIds.mockReturnValue([]);
    connection.readyPeerIdsForLane.mockReturnValue([]);
    connection.readPeer.mockReturnValue(undefined);
    connection.ensurePeerLaneOpen.mockImplementation(async (peerId, laneId = 'reliable') => ({
        status: 'no-lane',
        peerId,
        laneId,
        error: new Error('No lane installed for this test')
    }));
});

describe('Rallar room realtime channel', () => {
    it('waits for a room lane and sends JSON only to ready room peers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-ready', 'motion');
        const slow = await createNativeRealtimeLaneFixture('peer-slow', 'motion', { open: false });
        const sendJson = vi.spyOn(ready.channel, 'sendJson');
        mockRoomMembers(['session-1', 'peer-ready', 'peer-slow']);
        connection.ensurePeerLaneOpen.mockImplementation(async (peerId, laneId = 'motion') =>
            peerId === 'peer-ready'
                ? { status: 'open', peerId, laneId, channel: ready.channel }
                : { status: 'timeout', peerId, laneId, channel: slow.channel, error: new Error('timeout') }
        );

        const result = await createRallarFacade().realtime.room<{ x: number; }>({
            roomId: 'room-1',
            laneId: 'motion',
            waitTimeoutMs: 100,
            openTimeoutMs: 25
        }).send({ x: 1 }, { key: 'motion:peer-ready', maxAgeMs: 120 });

        expect(result.status).toBe('partial');
        expect(result.peerIds).toEqual(['peer-ready']);
        expect(result.readiness?.status).toBe('partial');
        expect(sendJson).toHaveBeenCalledWith({ x: 1 }, expect.objectContaining({ key: 'motion:peer-ready', maxAgeMs: 120 }));
        expect(ready.native.sent).toEqual([JSON.stringify({ x: 1 })]);
        expect(slow.native.sent).toEqual([]);
        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-ready', 'motion', expect.objectContaining({ timeoutMs: 100 }));
    });

    it('does not send when a room lane has no ready peers after waiting', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const slow = await createNativeRealtimeLaneFixture('peer-slow', 'motion', { open: false });
        mockRoomMembers(['session-1', 'peer-slow']);
        connection.ensurePeerLaneOpen.mockResolvedValue({
            status: 'timeout',
            peerId: 'peer-slow',
            laneId: 'motion',
            channel: slow.channel,
            error: new Error('timeout')
        });

        const result = await createRallarFacade().realtime.room<{ x: number; }>({ roomId: 'room-1', laneId: 'motion', waitTimeoutMs: 100 }).send({ x: 1 });

        expect(result.status).toBe('not-ready');
        expect(result.peerIds).toEqual([]);
        expect(result.readiness?.status).toBe('timeout');
        expect(slow.native.sent).toEqual([]);
    });

    it('does not open or send for a room the current session has not joined', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-ready', 'motion');
        mockRoomMembers(['peer-ready']);

        const result = await createRallarFacade().realtime.room<{ x: number; }>({ roomId: 'room-1', laneId: 'motion', waitTimeoutMs: 100 }).send({ x: 1 });

        expect(result.status).toBe('no-targets');
        expect(result.peerIds).toEqual([]);
        expect(result.desiredPeerIds).toEqual([]);
        expect(connection.ensurePeerLaneOpen).not.toHaveBeenCalled();
        expect(ready.native.sent).toEqual([]);
    });

    it('uses already-ready room peers without a readiness wait', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-ready', 'motion');
        mockRoomMembers(['session-1', 'peer-ready']);
        connection.knownPeerIds.mockReturnValue(['peer-ready']);
        connection.activePeerIds.mockReturnValue(['peer-ready']);
        connection.readyPeerIdsForLane.mockReturnValue(['peer-ready']);
        connection.ensurePeerLaneOpen.mockResolvedValue({ status: 'open', peerId: 'peer-ready', laneId: 'motion', channel: ready.channel });

        const result = await createRallarFacade().realtime.room<{ x: number; }>({ roomId: 'room-1', laneId: 'motion', waitTimeoutMs: 100 }).send({ x: 1 });

        expect(result.status).toBe('sent');
        expect(result.readiness).toBeUndefined();
        expect(ready.native.sent).toEqual([JSON.stringify({ x: 1 })]);
    });
});

function mockRoomMembers(sessionIds: readonly string[]): void {
    const snapshot = createGroupSnapshotFixture({ applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1', sessionIds });
    mocks.getAllGroupStateSnapshots.mockReturnValue([snapshot]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) => isSameGroupRef(snapshot.group, ref) ? snapshot : undefined);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshot.activeSessions.some((session) => session.sessionId === sessionId) ? snapshot.group : undefined
    );
}
