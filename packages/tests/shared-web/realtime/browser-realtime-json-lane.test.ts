import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type * as ClientStateSnapshotsRepositoryModule from '@shared/repository/client-state-snapshots-repository.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

interface GameplayPosition {
    readonly x: number;
}

describe('Rallar realtime JSON lane', () => {
    it('sends and receives through a typed lane backed by the native data channel', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lane = await createNativeRealtimeLaneFixture('peer-1', 'gameplay');
        const sendJson = vi.spyOn(lane.channel, 'sendJson');
        connection.activePeerIds.mockReturnValue(['peer-1']);
        connection.readPeer.mockReturnValue(lane.peer);
        connection.ensurePeerLaneOpen.mockResolvedValueOnce({ status: 'open', peerId: 'peer-1', laneId: 'gameplay', channel: lane.channel });
        const facade = createRallarFacade();
        const gameplay = facade.realtime.json<GameplayPosition>({
            laneId: 'gameplay',
            peerIds: ['peer-1'],
            openTimeoutMs: 750,
            key: 'player-1',
            maxAgeMs: 250
        });
        const messages: GameplayPosition[] = [];
        gameplay.on((message) => {
            messages.push(message.data);
        });
        await facade.connect();

        const results = await gameplay.send({ x: 1 });
        await lane.native.receive(JSON.stringify({ x: 2 }));

        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith('peer-1', 'gameplay', expect.objectContaining({ timeoutMs: 750 }));
        expect(sendJson).toHaveBeenCalledWith({ x: 1 }, expect.objectContaining({ key: 'player-1', maxAgeMs: 250 }));
        expect(lane.native.sent).toEqual([JSON.stringify({ x: 1 })]);
        expect(results).toEqual([{ peerId: 'peer-1', laneId: 'gameplay', result: { status: 'sent', bufferedAmount: 0, key: 'player-1' } }]);
        expect(messages).toEqual([{ x: 2 }]);
    });
});
