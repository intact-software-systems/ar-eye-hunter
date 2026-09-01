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

interface PositionUpdate {
    readonly x: number;
}

describe('Rallar targeted channel', () => {
    it('sends targeted JSON to unique explicit peers and skips the current session', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const ready = await createNativeRealtimeLaneFixture('peer-a', 'realtime');
        const slow = await createNativeRealtimeLaneFixture('peer-b', 'realtime', { open: false });
        connection.ensurePeerLaneOpen.mockImplementation(async (peerId, laneId = 'reliable') =>
            peerId === 'peer-a'
                ? { status: 'open', peerId, laneId, channel: ready.channel }
                : { status: 'timeout', peerId, laneId, channel: slow.channel, error: new Error('slow peer') }
        );

        const result = await createRallarFacade().channels.targeted<PositionUpdate>({
            peerIds: ['session-1', 'peer-a', 'peer-b', 'peer-a'],
            laneId: 'realtime',
            openTimeoutMs: 25
        }).send({ x: 1 });

        expect(result).toMatchObject({
            transport: 'rtc',
            status: 'partial',
            laneId: 'realtime',
            peerIds: ['peer-a', 'peer-b'],
            results: [
                { peerId: 'peer-a', result: { status: 'sent', bufferedAmount: 0 } },
                { peerId: 'peer-b', result: { status: 'closed', reason: 'Realtime lane not connected' } }
            ]
        });
        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-a', 'realtime', expect.objectContaining({ timeoutMs: 25 }));
        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-b', 'realtime', expect.objectContaining({ timeoutMs: 25 }));
        expect(ready.native.sent).toEqual([JSON.stringify({ x: 1 })]);
        expect(slow.native.sent).toEqual([]);
    });

    it('re-resolves live room membership before every native targeted send', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const firstPeer = await createNativeRealtimeLaneFixture('peer-a', 'realtime');
        const secondPeer = await createNativeRealtimeLaneFixture('peer-b', 'realtime');
        connection.ensurePeerLaneOpen.mockImplementation(async (peerId, laneId = 'reliable') => ({
            status: 'open',
            peerId,
            laneId,
            channel: peerId === 'peer-a' ? firstPeer.channel : secondPeer.channel
        }));
        mockRoomMembers(['session-1', 'peer-a']);
        const facade = createRallarFacade();
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        const channel = facade.channels.room<PositionUpdate>({ roomId: 'room-1', laneId: 'realtime' });

        const first = await channel.send({ x: 1 });
        mockRoomMembers(['session-1', 'peer-a', 'peer-b']);
        const second = await channel.send({ x: 2 });

        expect(first.peerIds).toEqual(['peer-a']);
        expect(second.peerIds).toEqual(['peer-a', 'peer-b']);
        expect(firstPeer.native.sent).toEqual([JSON.stringify({ x: 1 }), JSON.stringify({ x: 2 })]);
        expect(secondPeer.native.sent).toEqual([JSON.stringify({ x: 2 })]);
        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-b', 'realtime', expect.objectContaining({ timeoutMs: 5_000 }));
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
