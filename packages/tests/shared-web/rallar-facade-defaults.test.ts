import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { QRtcDataChannel, RtcDataChannelSendResult } from '@shared/webrtc/QRtcDataChannel.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

type MiddlewareModule = typeof import('@shared-web/browser/middleware.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import('./api-middleware-test-double.ts');
    const ctx = createApiMiddlewareTestDouble();
    return {
        ctx,
        webRtcConnectionService: ctx.middleware.webRtcConnectionService,
        hydrateStateCache: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['hydrate']>(() => Promise.resolve()),
        initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(() => Promise.resolve(ctx.middleware)),
        onCacheChange: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['onChange']>(() => vi.fn()),
        readSession: vi.fn<AuthModule['readSession']>(() => ctx.session),
        refreshStateSnapshots: vi.fn<RefreshStateSnapshotsModule['refreshStateSnapshots']>(
            () => Promise.resolve({ clients: [], groups: [] })
        ),
        clientRepositoryMissing: vi.fn(() => undefined),
        getAllClientStateSnapshots: vi.fn<ClientStateSnapshotsRepositoryModule['getAllClientStateSnapshots']>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<GroupStateSnapshotsRepositoryModule['findFirstGroupStateSnapshotRefSessionIdIsIn']>(() => undefined),
        findGroupStateSnapshotByRef: vi.fn<GroupStateSnapshotsRepositoryModule['findGroupStateSnapshotByRef']>(() => undefined),
        getAllGroupStateSnapshots: vi.fn<GroupStateSnapshotsRepositoryModule['getAllGroupStateSnapshots']>(() => [])
    };
});

vi.mock(
    import('@shared-web/browser/middleware.ts'),
    (): Partial<MiddlewareModule> => ({
        initialiseMiddleware: mocks.initialiseMiddleware
    })
);

vi.mock(
    import('@shared-web/browser/state-read/refresh-state-snapshots.ts'),
    (): Partial<RefreshStateSnapshotsModule> => ({
        refreshStateSnapshots: mocks.refreshStateSnapshots
    })
);

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<StateCacheLifecycleModule> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn()
        }
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn()
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<GroupStateSnapshotsRepositoryModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
    })
);

describe('Rallar facade default scope behavior', () => {
    beforeEach(async () => {
        (
            await import('@shared-web/browser/connection/browser-transport-runtime.ts')
        ).browserTransportRuntime.shutdown('test-reset');
        vi.clearAllMocks();
        mocks.clientRepositoryMissing.mockReturnValue(undefined);
        mocks.getAllClientStateSnapshots.mockReturnValue([]);
        mockGroupRepositoryMissing();
        mocks.hydrateStateCache.mockResolvedValue(undefined);
        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
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
            mocks.ctx.session,
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
        const sendResult: RtcDataChannelSendResult = {
            status: 'sent',
            bufferedAmount: 0
        };
        const sendJson = vi.fn(() => sendResult);
        const gameplayChannel = toWebRtcTestDouble<QRtcDataChannel>({
            sendJson
        });
        mockGroupSnapshot(createGroupSnapshot('match-1', ['session-1', 'peer-1']));
        vi.mocked(
            mocks.webRtcConnectionService.ensurePeerLaneOpen
        ).mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'gameplay',
            channel: gameplayChannel
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

        expect(
            mocks.webRtcConnectionService.ensurePeerLaneOpen
        ).toHaveBeenCalledWith(
            'peer-1',
            'gameplay',
            expect.objectContaining({
                timeoutMs: 750
            })
        );
        expect(sendJson).toHaveBeenCalledWith(
            {
                x: 1
            },
            expect.any(Object)
        );
        expect(result).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'gameplay',
                result: sendResult
            }
        ]);
    });

    it('uses facade RTC wait defaults when waiting for a lane', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        vi.mocked(
            mocks.webRtcConnectionService.ensurePeerLaneOpen
        ).mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable'
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

        expect(
            mocks.webRtcConnectionService.ensurePeerLaneOpen
        ).toHaveBeenCalledWith(
            'peer-1',
            'reliable',
            expect.objectContaining({
                timeoutMs: 333
            })
        );
        expect(result).toMatchObject({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable'
        });
    });
});

function mockGroupRepositoryMissing(): void {
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
}

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.getAllGroupStateSnapshots.mockImplementation(() => [...snapshots]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) =>
        snapshots.find(
            (snapshot) =>
                snapshot.group.groupId === ref.groupId &&
                snapshot.group.applicationId === ref.applicationId &&
                snapshot.group.workspaceId === ref.workspaceId
        )
    );
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation(
        (sessionId) => snapshots.find((snapshot) => sessionId === snapshot.group.groupId)?.group
    );
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {}
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds
    });
}

// QRtcDataChannel is a concrete WebRTC runtime value that cannot be instantiated in a unit test;
// only the members the facade calls are supplied, and their shapes stay checked against the
// production type.
function toWebRtcTestDouble<TValue>(members: Partial<TValue>): TValue {
    return members as TValue;
}
