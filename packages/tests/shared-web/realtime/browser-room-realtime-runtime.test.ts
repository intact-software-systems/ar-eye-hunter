import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { browserTransportRuntime, type BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type * as ClientStateSnapshotsRepositoryModule from '@shared/repository/client-state-snapshots-repository.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import type * as OverlaysRepositoryModule from '@shared/repository/overlays-repository.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';

import { createRoomTransportFixture, type RoomTransportFixture } from './create-room-transport-fixture.ts';
import { createNativeRealtimeLaneFixture } from './native-realtime-lane-fixture.ts';

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    const context = createDefaultApiMiddlewareTestDouble();
    return {
        context,
        findAcceptedOverlayById: vi.fn<typeof OverlaysRepositoryModule.findAcceptedOverlayById>(),
        hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(async () => {}),
        initialiseApiMiddleware: vi.fn<BrowserTransportRuntimePort['init']>(async () => context),
        onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
        readSession: vi.fn<typeof AuthModule.readSession>(() => context.session),
        findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(),
        getAllClientStateSnapshots: vi.fn<typeof ClientStateSnapshotsRepositoryModule.getAllClientStateSnapshots>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findFirstGroupStateSnapshotRefSessionIdIsIn>(),
        findGroupStateSnapshotByRef: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef>(),
        getAllGroupStateSnapshots: vi.fn<typeof GroupStateSnapshotsRepositoryModule.getAllGroupStateSnapshots>(() => [])
    };
});

const connection = vi.mocked(mocks.context.middleware.webRtcConnectionService);

vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), (): Partial<typeof MiddlewareModule> => ({
    initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
}));
vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), (): Partial<typeof StateCacheLifecycleModule> => ({
    browserStateCacheLifecycle: {
        hydrate: mocks.hydrateStateCache,
        onChange: mocks.onCacheChange,
        initialise: vi.fn(),
        cancelSnapshotAssemblies: vi.fn(() => undefined)
    }
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

vi.mock(import('@shared/repository/overlays-repository.ts'), async (importOriginal) => ({
    ...await importOriginal(),
    findAcceptedOverlayById: mocks.findAcceptedOverlayById
}));

let roomVersion = 0;

afterEach(() => {
    browserTransportRuntime.shutdown();
});

beforeEach(() => {
    vi.clearAllMocks();
    roomVersion = 0;
    mocks.findAcceptedOverlayById.mockReturnValue(undefined);
    mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
    mocks.getAllClientStateSnapshots.mockReturnValue([]);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
    mocks.hydrateStateCache.mockResolvedValue(undefined);
    mocks.initialiseApiMiddleware.mockResolvedValue(mocks.context);
    mocks.readSession.mockReturnValue(mocks.context.session);
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

interface PositionUpdate {
    readonly x: number;
}

describe('Rallar room realtime channel', () => {
    it('waits for a room lane and sends JSON only to ready room peers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-ready', 'motion');
        const slow = await createNativeRealtimeLaneFixture('peer-slow', 'motion', { open: false });
        const sendJson = vi.spyOn(ready.channel, 'sendJson');
        mockRoomMembers(['session-1', 'peer-ready', 'peer-slow']);
        connection.knownPeerIds.mockReturnValue(['peer-ready', 'peer-slow']);
        connection.activePeerIds.mockReturnValue(['peer-ready']);
        connection.readPeer.mockImplementation((peerId) => peerId === 'peer-ready' ? ready.peer : peerId === 'peer-slow' ? slow.peer : undefined);
        connection.ensurePeerLaneOpen.mockImplementation(async (peerId, laneId = 'motion') => {
            if (peerId === 'peer-ready') {
                connection.readyPeerIdsForLane.mockReturnValue(['peer-ready']);
                return { status: 'open', peerId, laneId, channel: ready.channel };
            }
            return { status: 'timeout', peerId, laneId, channel: slow.channel, error: new Error('timeout') };
        });

        const result = await createRallarFacade().realtime.room<PositionUpdate>({
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

    it('preserves room send defaults and applies explicit per-send overrides', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-ready', 'motion', { flowControl: { overflow: 'queue' } });
        mockRoomMembers(['session-1', 'peer-ready']);
        connection.readyPeerIdsForLane.mockReturnValue(['peer-ready']);
        connection.ensurePeerLaneOpen.mockResolvedValue({ status: 'open', peerId: 'peer-ready', laneId: 'motion', channel: ready.channel });
        ready.native.bufferedAmount = 64 * 1024 + 1;
        const channel = createRallarFacade().realtime.room<PositionUpdate>({
            roomId: 'room-1',
            laneId: 'motion',
            key: 'default-key',
            maxAgeMs: 10,
            now: () => 0,
            openTimeoutMs: 123
        });
        const first = await channel.send({ x: 1 });
        expect(first.results).toMatchObject([{ result: { status: 'queued', key: 'default-key' } }]);
        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-ready', 'motion', { timeoutMs: 123 });
        ready.native.bufferedAmount = 0;
        await ready.native.drain();
        expect(ready.native.sent).toEqual([]);
        expect(ready.channel.readHealth().counters.droppedStale).toBe(1);

        ready.native.bufferedAmount = 64 * 1024 + 1;
        const second = await channel.send({ x: 2 }, { key: 'override-key', maxAgeMs: 60_000, now: Date.now, openTimeoutMs: 456 });
        expect(second.results).toMatchObject([{ result: { status: 'queued', key: 'override-key' } }]);
        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-ready', 'motion', { timeoutMs: 456 });
        ready.native.bufferedAmount = 0;
        await ready.native.drain();
        expect(ready.native.sent).toEqual([JSON.stringify({ x: 2 })]);
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

        const result = await createRallarFacade().realtime.room<PositionUpdate>({ roomId: 'room-1', laneId: 'motion', waitTimeoutMs: 100 }).send({ x: 1 });

        expect(result.status).toBe('not-ready');
        expect(result.peerIds).toEqual([]);
        expect(result.readiness?.status).toBe('timeout');
        expect(slow.native.sent).toEqual([]);
    });

    it('does not open or send for a room the current session has not joined', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-ready', 'motion');
        mockRoomMembers(['peer-ready']);

        const result = await createRallarFacade().realtime.room<PositionUpdate>({ roomId: 'room-1', laneId: 'motion', waitTimeoutMs: 100 }).send({ x: 1 });

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

        const result = await createRallarFacade().realtime.room<PositionUpdate>({ roomId: 'room-1', laneId: 'motion', waitTimeoutMs: 100 }).send({ x: 1 });

        expect(result.status).toBe('sent');
        expect(result.readiness).toBeUndefined();
        expect(ready.native.sent).toEqual([JSON.stringify({ x: 1 })]);
    });
    it('does not send to a peer removed from the accepted layout during readiness wait', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const removed = await createNativeRealtimeLaneFixture('peer-removed', 'motion');
        mockRoomMembers(['session-1', 'peer-removed']);
        connection.ensurePeerLaneOpen.mockImplementation(async (peerId, laneId = 'motion') => {
            mockRoomMembers(['session-1', 'peer-current']);
            connection.readyPeerIdsForLane.mockReturnValue(['peer-removed']);
            return { status: 'open', peerId, laneId, channel: removed.channel };
        });
        const result = await createRallarFacade().realtime.room<PositionUpdate>({ roomId: 'room-1', laneId: 'motion' }).send({ x: 1 });
        expect(result.status).toBe('not-ready');
        expect(result.peerIds).toEqual([]);
        expect(result.desiredPeerIds).toEqual(['peer-current']);
        expect(result.readiness?.readyPeerIds).toEqual([]);
        expect(result.transportStatus?.rtc.readyPeerIds).toEqual([]);
        expect(removed.native.sent).toEqual([]);
    });

    it('returns halted without waiting or sending while room transport is halted', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-ready', 'motion');
        const fixture = mockRoomMembers(['session-1', 'peer-ready']);
        mockRoomTransport({ ...fixture, snapshot: { ...fixture.snapshot, group: { ...fixture.snapshot.group, transportState: 'halted' } } });
        const result = await createRallarFacade().realtime.room<PositionUpdate>({ roomId: 'room-1', laneId: 'motion' }).send({ x: 1 });
        expect(result.status).toBe('halted');
        expect(result.desiredPeerIds).toEqual(['peer-ready']);
        expect(result.transportStatus?.rtc.state).toBe('halted');
        expect(result.readiness).toBeUndefined();
        expect(ready.native.sent).toEqual([]);
    });

    it('reports a fresh halt that prevents the final native room write', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-ready', 'motion');
        const fixture = mockRoomMembers(['session-1', 'peer-ready']);
        connection.readyPeerIdsForLane.mockReturnValue(['peer-ready']);
        const laneStarted = Promise.withResolvers<void>();
        const laneCompletion = Promise.withResolvers<WebRtcConnectionService.PeerLaneOpenResult>();
        connection.ensurePeerLaneOpen.mockImplementation(async () => {
            laneStarted.resolve();
            return await laneCompletion.promise;
        });
        const pending = createRallarFacade().realtime.room<PositionUpdate>({ roomRef: fixture.snapshot.group, laneId: 'motion' }).send({ x: 1 });
        await laneStarted.promise;
        mockRoomTransport({ ...fixture, snapshot: { ...fixture.snapshot, group: { ...fixture.snapshot.group, transportState: 'halted' } } });
        laneCompletion.resolve({ status: 'open', peerId: 'peer-ready', laneId: 'motion', channel: ready.channel });
        const result = await pending;
        expect(result.status).toBe('halted');
        expect(result.transportStatus?.rtc.state).toBe('halted');
        expect(result.results).toMatchObject([{ peerId: 'peer-ready', result: { status: 'closed' } }]);
        expect(ready.native.sent).toEqual([]);
    });

    it('pins a room channel scope before connection hydrates its accepted layout', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-ready', 'motion');
        const connectStarted = Promise.withResolvers<void>();
        const connectCompletion = Promise.withResolvers<void>();
        mocks.initialiseApiMiddleware.mockImplementation(async () => {
            connectStarted.resolve();
            await connectCompletion.promise;
            mockRoomMembers(['session-1', 'peer-ready']);
            connection.readyPeerIdsForLane.mockReturnValue(['peer-ready']);
            return mocks.context;
        });
        connection.ensurePeerLaneOpen.mockResolvedValue({ status: 'open', peerId: 'peer-ready', laneId: 'motion', channel: ready.channel });
        const facade = createRallarFacade();
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        const pending = facade.realtime.room<PositionUpdate>({ roomId: 'room-1', laneId: 'motion' }).send({ x: 1 });
        await connectStarted.promise;
        facade.setDefaults({ applicationId: 'other-app', workspaceId: 'other-workspace' });
        connectCompletion.resolve();
        const result = await pending;
        expect(result.status).toBe('sent');
        expect(result.roomRef).toMatchObject({ applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' });
        expect(ready.native.sent).toEqual([JSON.stringify({ x: 1 })]);
    });
});

function mockRoomMembers(sessionIds: readonly string[]): RoomTransportFixture {
    const fixture = createRoomTransportFixture({
        roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
        sessionIds,
        acceptedPeerIds: sessionIds,
        version: ++roomVersion
    });
    mockRoomTransport(fixture);
    return fixture;
}

function mockRoomTransport(fixture: RoomTransportFixture): void {
    const { snapshot, acceptedOverlay } = fixture;
    mocks.getAllGroupStateSnapshots.mockReturnValue([snapshot]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) => isSameGroupRef(snapshot.group, ref) ? snapshot : undefined);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshot.activeSessions.some((session) => session.sessionId === sessionId) ? snapshot.group : undefined
    );
    mocks.findAcceptedOverlayById.mockImplementation((overlayId) => overlayId === acceptedOverlay.overlayId ? acceptedOverlay : undefined);
}
