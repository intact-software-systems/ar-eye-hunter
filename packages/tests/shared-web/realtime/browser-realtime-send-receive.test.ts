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
import type { RallarRealtimeHandler, RallarRealtimeMessage } from '@shared-web/browser/rallar-realtime-facade.ts';
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

vi.mock(import('@shared/repository/overlays-repository.ts'), async (importOriginal) => ({
    ...await importOriginal(),
    findAcceptedOverlayById: mocks.findAcceptedOverlayById
}));

afterEach(() => {
    browserTransportRuntime.shutdown();
});

beforeEach(() => {
    vi.clearAllMocks();
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

describe('Rallar realtime send and listen', () => {
    it('sends realtime JSON over the requested peer lane', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        const sendJson = vi.spyOn(lane.channel, 'sendJson');
        connection.ensurePeerLaneOpen.mockResolvedValueOnce({ status: 'open', peerId: 'peer-1', laneId: 'realtime', peer: lane.peer, channel: lane.channel });

        const result = await createRallarFacade().realtime.sendJson({ peerIds: ['peer-1'], data: { x: 1 }, key: 'player-1' });

        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-1', 'realtime', expect.objectContaining({ timeoutMs: 5_000 }));
        expect(sendJson).toHaveBeenCalledWith({ x: 1 }, expect.objectContaining({ key: 'player-1' }));
        expect(lane.native.sent).toEqual([JSON.stringify({ x: 1 })]);
        expect(result).toEqual([{ peerId: 'peer-1', laneId: 'realtime', result: { status: 'sent', bufferedAmount: 0, key: 'player-1' } }]);
    });

    it('lets a JSON lane send roomId override its default roomRef', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        const fixture = createRoomTransportFixture({
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
            sessionIds: ['session-1', 'peer-1'],
            acceptedPeerIds: ['peer-1'],
            version: 1
        });
        mockRoomTransport(fixture);
        connection.ensurePeerLaneOpen.mockResolvedValue({ status: 'open', peerId: 'peer-1', laneId: 'realtime', channel: lane.channel });
        const json = createRallarFacade().realtime.json<PositionUpdate>({ roomRef: fixture.snapshot.group });
        await expect(json.send({ x: 1 }, { roomId: 'other-room' })).resolves.toEqual([]);
        expect(lane.native.sent).toEqual([]);
    });

    it('does not send realtime JSON before the requested lane opens', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime', { open: false });
        connection.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'timeout',
            peerId: 'peer-1',
            laneId: 'realtime',
            channel: lane.channel,
            error: new Error('lane did not open')
        });

        const result = await createRallarFacade().realtime.sendJson({ peerIds: ['peer-1'], data: { x: 1 }, openTimeoutMs: 25 });

        expect(result).toEqual([{
            peerId: 'peer-1',
            laneId: 'realtime',
            result: { status: 'closed', reason: 'Realtime lane not connected', bufferedAmount: 0 }
        }]);
        expect(lane.native.sent).toEqual([]);
        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-1', 'realtime', expect.objectContaining({ timeoutMs: 25 }));
    });

    it('sends realtime binary over the requested peer lane', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        const bytes = new Uint8Array([1, 2, 3]);
        connection.ensurePeerLaneOpen.mockResolvedValueOnce({ status: 'open', peerId: 'peer-1', laneId: 'realtime', channel: lane.channel });

        const result = await createRallarFacade().realtime.sendBinary({ peerIds: ['peer-1'], data: bytes, openTimeoutMs: 75 });

        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-1', 'realtime', expect.objectContaining({ timeoutMs: 75 }));
        expect(lane.native.sent).toEqual([bytes]);
        expect(result).toEqual([{ peerId: 'peer-1', laneId: 'realtime', result: { status: 'sent', bufferedAmount: 0 } }]);
    });

    it('returns a closed send result when the peer has no requested lane', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        connection.ensurePeerLaneOpen.mockResolvedValueOnce({ status: 'no-lane', peerId: 'peer-1', laneId: 'missing', error: new Error('missing lane') });

        const result = await createRallarFacade().realtime.sendJson({ peerIds: ['peer-1'], laneId: 'missing', data: { x: 1 } });

        expect(result).toEqual([{
            peerId: 'peer-1',
            laneId: 'missing',
            result: { status: 'closed', reason: 'Realtime lane not connected', bufferedAmount: 0 }
        }]);
        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-1', 'missing', expect.objectContaining({ timeoutMs: 5_000 }));
    });

    it('registers JSON listeners on connected peers and detaches the last subscriber', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        connection.activePeerIds.mockReturnValue(['peer-1']);
        connection.knownPeerIds.mockReturnValue(['peer-1']);
        connection.readPeer.mockReturnValue(lane.peer);
        const messages: PositionUpdate[] = [];
        const facade = createRallarFacade();
        const unsubscribe = facade.realtime.onJson<PositionUpdate>('realtime', (message) => {
            messages.push(message.data);
        });
        await facade.connect();

        await lane.native.receive(JSON.stringify({ x: 1 }));
        expect(messages).toEqual([{ x: 1 }]);
        expect(lane.channel.readHealth().rawCallbackCount).toBe(1);
        unsubscribe();
        await lane.native.receive(JSON.stringify({ x: 2 }));

        expect(messages).toEqual([{ x: 1 }]);
        expect(lane.channel.readHealth().rawCallbackCount).toBe(0);
    });

    it('registers listeners added after connect and preserves duplicate handler identity', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        connection.activePeerIds.mockReturnValue(['peer-1']);
        connection.knownPeerIds.mockReturnValue(['peer-1']);
        connection.readPeer.mockReturnValue(lane.peer);
        const facade = createRallarFacade();
        await facade.connect();
        const messages: PositionUpdate[] = [];
        const handler: RallarRealtimeHandler<PositionUpdate> = (message) => {
            messages.push(message.data);
        };

        const unsubscribe = facade.realtime.onJson('realtime', handler);
        facade.realtime.onJson('realtime', handler);
        await lane.native.receive(JSON.stringify({ x: 1 }));
        expect(messages).toEqual([{ x: 1 }]);
        unsubscribe();
        await lane.native.receive(JSON.stringify({ x: 2 }));

        expect(messages).toEqual([{ x: 1 }]);
        expect(lane.channel.readHealth().rawCallbackCount).toBe(0);
    });

    it('rejects malformed JSON without exposing its payload in logs and accepts the next message', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        connection.activePeerIds.mockReturnValue(['peer-1']);
        connection.readPeer.mockReturnValue(lane.peer);
        const messages: PositionUpdate[] = [];
        const facade = createRallarFacade();
        facade.realtime.onJson<PositionUpdate>('realtime', (message) => {
            messages.push(message.data);
        });
        await facade.connect();
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await lane.native.receive('private-message-content{');
            expect(messages).toEqual([]);
            expect(logged).toHaveBeenCalledWith('Error parsing Rallar realtime JSON message');
            expect(logged.mock.calls.flat()).not.toContain(expect.any(Error));
            await lane.native.receive(JSON.stringify({ x: 2 }));
            expect(messages).toEqual([{ x: 2 }]);
        }
        finally {
            logged.mockRestore();
        }
    });

    it.each([
        ['ArrayBuffer', new Uint8Array([1, 2, 3]).buffer],
        ['typed array subview', new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4)],
        ['DataView', new DataView(new Uint8Array([0, 1, 2, 3, 4]).buffer, 1, 3)],
        ['Blob', new Blob([new Uint8Array([1, 2, 3])])]
    ])('normalizes a native %s message to an ArrayBuffer', async (_kind, data) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        connection.activePeerIds.mockReturnValue(['peer-1']);
        connection.readPeer.mockReturnValue(lane.peer);
        const messages: RallarRealtimeMessage<ArrayBuffer>[] = [];
        const facade = createRallarFacade();
        facade.realtime.onBinary('realtime', (message) => {
            messages.push(message);
        });
        await facade.connect();

        await lane.native.receive(data);

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ peerId: 'peer-1', laneId: 'realtime' });
        expect(Array.from(new Uint8Array(messages[0].data))).toEqual([1, 2, 3]);
    });

    it('exposes actual send and queue health for active peer lanes', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime', { flowControl: { overflow: 'queue' } });
        connection.activePeerIds.mockReturnValue(['peer-1']);
        connection.readPeer.mockReturnValue(lane.peer);
        lane.channel.sendJson({ x: 1 });
        lane.channel.sendJson({ x: 2 });
        lane.native.bufferedAmount = 64 * 1024 + 1;
        lane.channel.sendJson({ x: 3 });
        const facade = createRallarFacade();
        await facade.connect();

        expect(facade.realtime.health({ laneIds: ['realtime'] })).toMatchObject([{
            peerId: 'peer-1',
            laneId: 'realtime',
            channel: {
                state: 'Open',
                readyState: 'open',
                bufferedAmount: 64 * 1024 + 1,
                queuedItemCount: 1,
                counters: { sent: 2, queued: 1 }
            }
        }]);
        expect(lane.native.sent).toEqual([JSON.stringify({ x: 1 }), JSON.stringify({ x: 2 })]);
    });
    it.each([
        { format: 'JSON', change: 'halt' },
        { format: 'binary', change: 'halt' },
        { format: 'JSON', change: 'layout-removal' },
        { format: 'binary', change: 'layout-removal' }
    ])('reauthorizes $format room sends after lane opening when authority changes by $change', async ({ format, change }) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
        const fixture = createRoomTransportFixture({ roomRef, sessionIds: ['session-1', 'peer-1'], acceptedPeerIds: ['peer-1'], version: 1 });
        mockRoomTransport(fixture);
        const laneStarted = Promise.withResolvers<void>();
        const laneCompletion = Promise.withResolvers<WebRtcConnectionService.PeerLaneOpenResult>();
        connection.ensurePeerLaneOpen.mockImplementation(async () => {
            laneStarted.resolve();
            return await laneCompletion.promise;
        });
        const facade = createRallarFacade();
        const pending = format === 'JSON'
            ? facade.realtime.sendJson({ roomRef, peerIds: ['peer-1'], data: { x: 1 } })
            : facade.realtime.sendBinary({ roomRef, peerIds: ['peer-1'], data: new Uint8Array([1, 2]) });
        await laneStarted.promise;
        mockRoomTransport(
            change === 'halt'
                ? { ...fixture, snapshot: { ...fixture.snapshot, group: { ...fixture.snapshot.group, transportState: 'halted' } } }
                : createRoomTransportFixture({ roomRef, sessionIds: ['session-1', 'peer-1'], acceptedPeerIds: [], version: 2 })
        );
        laneCompletion.resolve({ status: 'open', peerId: 'peer-1', laneId: 'realtime', channel: lane.channel });
        const results = await pending;
        expect(results).toMatchObject([{ peerId: 'peer-1', result: { status: 'closed' } }]);
        expect(lane.native.sent).toEqual([]);
    });

    it.each(['JSON', 'binary'])('pins a bare room scope before connecting and hydrates targets before the %s send', async (format) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        const fixture = createRoomTransportFixture({
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
            sessionIds: ['session-1', 'peer-1'],
            acceptedPeerIds: ['peer-1'],
            version: 1
        });
        const connectStarted = Promise.withResolvers<void>();
        const connectCompletion = Promise.withResolvers<void>();
        mocks.initialiseApiMiddleware.mockImplementation(async () => {
            connectStarted.resolve();
            await connectCompletion.promise;
            mockRoomTransport(fixture);
            return mocks.context;
        });
        connection.ensurePeerLaneOpen.mockResolvedValue({ status: 'open', peerId: 'peer-1', laneId: 'realtime', channel: lane.channel });
        const facade = createRallarFacade();
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        const bytes = new Uint8Array([1, 2]);
        const pending = format === 'JSON'
            ? facade.realtime.sendJson({ roomId: 'room-1', data: { x: 1 } })
            : facade.realtime.sendBinary({ roomId: 'room-1', data: bytes });
        await connectStarted.promise;
        facade.setDefaults({ applicationId: 'other-app', workspaceId: 'other-workspace' });
        connectCompletion.resolve();
        await expect(pending).resolves.toMatchObject([{ peerId: 'peer-1', result: { status: 'sent' } }]);
        expect(lane.native.sent).toEqual([format === 'JSON' ? JSON.stringify({ x: 1 }) : bytes]);
    });

    it('does not let explicit peers bypass an unresolved or differently scoped room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'realtime');
        const fixture = createRoomTransportFixture({
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
            sessionIds: ['session-1', 'peer-1'],
            acceptedPeerIds: ['peer-1'],
            version: 1
        });
        mockRoomTransport(fixture);
        connection.ensurePeerLaneOpen.mockResolvedValue({ status: 'open', peerId: 'peer-1', laneId: 'realtime', channel: lane.channel });
        const facade = createRallarFacade();
        await expect(facade.realtime.sendJson({ roomId: 'unresolved-room', peerIds: ['peer-1'], data: { x: 1 } })).resolves.toEqual([]);
        await expect(facade.realtime.sendJson({
            roomRef: { ...fixture.snapshot.group, applicationId: 'other-app' },
            peerIds: ['peer-1'],
            data: { x: 2 }
        })).resolves.toEqual([]);
        expect(lane.native.sent).toEqual([]);
    });
});

function mockRoomTransport(fixture: RoomTransportFixture): void {
    const { snapshot, acceptedOverlay } = fixture;
    mocks.getAllGroupStateSnapshots.mockReturnValue([snapshot]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) => isSameGroupRef(snapshot.group, ref) ? snapshot : undefined);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshot.activeSessions.some((session) => session.sessionId === sessionId) ? snapshot.group : undefined
    );
    mocks.findAcceptedOverlayById.mockImplementation((overlayId) => overlayId === acceptedOverlay.overlayId ? acceptedOverlay : undefined);
}
