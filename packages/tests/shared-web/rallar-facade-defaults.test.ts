import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { browserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type * as RefreshStateSnapshotsModule from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type * as ClientStateSnapshotsRepositoryModule from '@shared/repository/client-state-snapshots-repository.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import type * as OverlaysRepositoryModule from '@shared/repository/overlays-repository.ts';

import { createRoomTransportFixture, type RoomTransportFixture } from './realtime/create-room-transport-fixture.ts';
import { createNativeRealtimeLaneFixture } from './realtime/native-realtime-lane-fixture.ts';

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import('./api-middleware-test-double.ts');
    const context = createDefaultApiMiddlewareTestDouble();
    return {
        context,
        hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(() => Promise.resolve()),
        initialiseMiddleware: vi.fn<typeof MiddlewareModule.initialiseMiddleware>(() => Promise.resolve(context.middleware)),
        onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
        readSession: vi.fn<typeof AuthModule.readSession>(() => context.session),
        refreshStateSnapshots: vi.fn<typeof RefreshStateSnapshotsModule.refreshStateSnapshots>(
            () => Promise.resolve({ clients: [], groups: [] })
        ),
        findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(),
        findAcceptedOverlayById: vi.fn<typeof OverlaysRepositoryModule.findAcceptedOverlayById>(),
        getAllClientStateSnapshots: vi.fn<typeof ClientStateSnapshotsRepositoryModule.getAllClientStateSnapshots>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findFirstGroupStateSnapshotRefSessionIdIsIn>(() =>
            undefined
        ),
        findGroupStateSnapshotByRef: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef>(() => undefined),
        getAllGroupStateSnapshots: vi.fn<typeof GroupStateSnapshotsRepositoryModule.getAllGroupStateSnapshots>(() => [])
    };
});

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    (): Partial<typeof MiddlewareModule> => ({
        initialiseMiddleware: mocks.initialiseMiddleware
    })
);

vi.mock(
    import('@shared-web/browser/state-read/refresh-state-snapshots.ts'),
    (): Partial<typeof RefreshStateSnapshotsModule> => ({
        refreshStateSnapshots: mocks.refreshStateSnapshots
    })
);

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<typeof StateCacheLifecycleModule> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn(),
            cancelSnapshotAssemblies: vi.fn(() => undefined)
        }
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<typeof AuthModule> => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn()
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<typeof ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<typeof GroupStateSnapshotsRepositoryModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
    })
);

vi.mock(import('@shared/repository/overlays-repository.ts'), async (importOriginal) => ({
    ...await importOriginal(),
    findAcceptedOverlayById: mocks.findAcceptedOverlayById
}));

const connection = vi.mocked(mocks.context.middleware.webRtcConnectionService);

describe('Rallar facade default scope behavior', () => {
    afterEach(() => {
        browserTransportRuntime.shutdown('test-cleanup');
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
        mocks.getAllClientStateSnapshots.mockReturnValue([]);
        mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
        mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
        mocks.getAllGroupStateSnapshots.mockReturnValue([]);
        mocks.findAcceptedOverlayById.mockReturnValue(undefined);
        mocks.hydrateStateCache.mockResolvedValue(undefined);
        mocks.initialiseMiddleware.mockResolvedValue(mocks.context.middleware);
        mocks.readSession.mockReturnValue(mocks.context.session);
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        connection.ensurePeerLaneOpen.mockReset().mockImplementation(async (peerId, laneId = 'reliable') => ({
            status: 'no-lane',
            peerId,
            laneId,
            error: new Error('No native lane installed for this scenario')
        }));
        connection.activePeerIds.mockReset().mockReturnValue([]);
        connection.knownPeerIds.mockReset().mockReturnValue([]);
        connection.readyPeerIdsForLane.mockReset().mockReturnValue([]);
        connection.readPeer.mockReset().mockReturnValue(undefined);
    });

    it('keeps defaults isolated between facade instances', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const first = createRallarFacade();
        const second = createRallarFacade();

        first.setDefaults({ applicationId: 'isolated-app' });

        expect(first.defaults()?.applicationId).toBe('isolated-app');
        expect(second.defaults()).toBeUndefined();
    });

    it('uses facade defaults as the operation scope when no explicit scope is passed', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();

        facade.setDefaults({
            applicationId: 'default-app'
        });

        await facade.people.refresh();

        expect(facade.defaults()).toEqual({
            applicationId: 'default-app'
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'default-app',
                workspaceId: 'default'
            },
            {}
        );
    });

    it('uses facade defaults to build RTC group refs from room id strings', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'game-app',
            workspaceId: 'arena-1'
        });

        const result = await facade.messages.rtc.send({
            roomId: 'match-1',
            typeId: 'game.input.v1',
            resourceId: 'input-1',
            payload: {
                x: 1
            }
        });

        expect(result.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'game-app',
                workspaceId: 'arena-1',
                groupId: 'match-1'
            }
        });
        expect(result.message.targets).not.toHaveProperty('groupId');
    });

    it('uses facade room defaults for RTC and WS sends without per-call room ids', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'game-app',
            workspaceId: 'arena-1',
            room: {
                roomId: 'match-1'
            }
        });

        const rtcResult = await facade.messages.rtc.send({
            typeId: 'game.input.v1',
            resourceId: 'rtc-input-1',
            payload: {
                x: 1
            }
        });
        const wsResult = await facade.messages.ws.send({
            topicId: 'room.game',
            typeId: 'game.event.v1',
            resourceId: 'ws-event-1',
            payload: {
                text: 'joined'
            }
        });

        expect(rtcResult.message.route).toMatchObject({
            contextId: 'match-1',
            resourceId: 'rtc-input-1'
        });
        expect(rtcResult.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'game-app',
                workspaceId: 'arena-1',
                groupId: 'match-1'
            }
        });
        expect(wsResult.message.route).toMatchObject({
            topicId: 'room.game',
            contextId: 'match-1',
            resourceId: 'ws-event-1'
        });
        expect(wsResult.message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room'
        });
    });

    it('uses facade operation and RTC lane defaults for connect and workflows', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const lanes = [
            {
                id: 'gameplay',
                label: 'gameplay-data',
                init: {
                    ordered: false,
                    maxRetransmits: 0
                }
            }
        ];
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'default-app',
            rtc: {
                dataChannelLanes: lanes,
                maxPeerConnections: 12,
                rttReportingDegreeLimit: 3
            },
            messages: {
                maxPayloadBytes: 2048
            },
            operations: {
                timeoutMs: 321
            }
        });

        await facade.people.refresh();

        expect(mocks.initialiseMiddleware).toHaveBeenCalledWith(
            mocks.context.session,
            expect.any(String),
            {
                onAuthInvalid: expect.any(Function),
                scope: {
                    applicationId: 'default-app',
                    workspaceId: 'default'
                },
                timeoutMs: 321,
                dataChannelLanes: lanes,
                maxPeerConnections: 12,
                rttReportingDegreeLimit: 3
            }
        );
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'default-app',
                workspaceId: 'default'
            },
            {
                command: {
                    timeoutMs: 321
                }
            }
        );
    });

    it('uses facade room and realtime defaults for realtime sends', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const gameplay = await createNativeRealtimeLaneFixture('peer-1', 'gameplay');
        mockRoomTransport(createRoomTransportFixture({
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'match-1' },
            sessionIds: ['session-1', 'peer-1'],
            acceptedPeerIds: ['peer-1'],
            version: 1
        }));
        connection.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'gameplay',
            peer: gameplay.peer,
            channel: gameplay.channel
        });
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            room: {
                roomId: 'match-1'
            },
            realtime: {
                laneId: 'gameplay',
                openTimeoutMs: 750
            }
        });

        const result = await facade.realtime.sendJson({
            data: {
                x: 1
            }
        });

        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith(
            'peer-1',
            'gameplay',
            expect.objectContaining({
                timeoutMs: 750
            })
        );
        expect(gameplay.native.sent).toEqual([JSON.stringify({ x: 1 })]);
        expect(result).toMatchObject([
            { peerId: 'peer-1', laneId: 'gameplay', result: { status: 'sent', bufferedAmount: 0 } }
        ]);
    });

    it('uses facade RTC wait defaults when waiting for a lane', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const reliable = await createNativeRealtimeLaneFixture('peer-1', 'reliable');
        connection.knownPeerIds.mockReturnValue(['peer-1']);
        connection.activePeerIds.mockReturnValue(['peer-1']);
        connection.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        connection.readPeer.mockReturnValue(reliable.peer);
        connection.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable',
            peer: reliable.peer,
            channel: reliable.channel
        });
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            rtc: {
                connectOnWait: true,
                waitTimeoutMs: 333
            }
        });

        await facade.connect();
        const result = await facade.rtc.waitForOpen('peer-1');

        expect(connection.ensurePeerLaneOpen).toHaveBeenCalledWith(
            'peer-1',
            'reliable',
            expect.objectContaining({
                timeoutMs: 333
            })
        );
        expect(result).toMatchObject({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable',
            lane: { isOpen: true, channel: { readyState: 'open' } }
        });
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
