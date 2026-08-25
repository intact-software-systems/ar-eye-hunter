import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/WebRtcConnectionService.ts';
import type { QRtcDataChannel, RtcDataChannelSendOptions, RtcDataChannelSendResult } from '@shared/webrtc/QRtcDataChannel.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';
import { createDirectorGroupSnapshot } from './director-group-snapshot-fixture.ts';

type MiddlewareModule = typeof import('@shared-web/browser/middleware.ts');
type ApiIntegrationModule = typeof import('@shared-web/browser/api-integration.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type ApiWorkflowsModule = typeof import('@shared-web/browser/api-workflows.ts');
type DataCachesModule = typeof import('@shared-web/browser/data-caches.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

interface PositionUpdate {
    readonly x: number;
}

interface ChannelHealthFixtureInput {
    readonly peerId: string;
    readonly label: string;
    readonly state: string;
    readonly readyState: RTCDataChannelState;
}

interface GroupSnapshotFixtureScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const mocks = await vi.hoisted(async () => {
    const { createLightweightBrowserFacadeTestMocks } = await import(
        './lightweight-browser-facade-test-mocks.ts'
    );
    return createLightweightBrowserFacadeTestMocks();
});

vi.mock(import('@shared-web/browser/middleware.ts'), (): Partial<MiddlewareModule> => ({
    initialiseMiddleware: async () => (await mocks.initMiddleware()).middleware
}));

vi.mock(
    import('@shared-web/browser/api-integration.ts'),
    (): Partial<ApiIntegrationModule> => ({
        listStateClientEventPage: mocks.listStateClientEventPage,
        listStateClientEvents: mocks.listStateClientEvents,
        listStateGroupEventPage: mocks.listStateGroupEventPage,
        listStateGroupEvents: mocks.listStateGroupEvents
    })
);

vi.mock(import('@shared-web/browser/auth/session-http-api.ts'), (): Partial<AuthApiModule> => ({
    loginToApi: mocks.loginToApi,
    logoutFromApi: mocks.logoutFromApi,
    registerWithApi: mocks.registerWithApi
}));

vi.mock(import('@shared-web/browser/api-workflows.ts'), (): Partial<ApiWorkflowsModule> => ({
    createAndJoinStateGroup: mocks.createAndJoinStateGroup,
    joinStateGroup: mocks.joinStateGroup,
    leaveStateGroup: mocks.leaveStateGroup,
    refreshStateSnapshots: mocks.refreshStateSnapshots,
    updateStateGroupMetadata: mocks.updateStateGroupMetadata
}));

vi.mock(import('@shared-web/browser/data-caches.ts'), (): Partial<DataCachesModule> => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: mocks.onStateCacheChange
}));

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: mocks.clearSession,
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: mocks.writeSession
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
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

describe('Rallar targeted channel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        resetRepositoryDoublesToMissing();
        resetMiddlewareDoublesToDefaults();
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.clearSession.mockImplementation(() => undefined);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.logoutFromApi.mockResolvedValue({ loggedOut: true });
        mocks.createAndJoinStateGroup.mockRejectedValue(new Error('create not mocked'));
        mocks.joinStateGroup.mockRejectedValue(new Error('join not mocked'));
        mocks.leaveStateGroup.mockRejectedValue(new Error('leave not mocked'));
        mocks.updateStateGroupMetadata.mockRejectedValue(
            new Error('metadata update not mocked')
        );
        mocks.registerWithApi.mockResolvedValue({
            clientId: 'client-new',
            username: 'new-user',
            displayName: null,
            registeredAtEpochMs: 1_000
        });
        mocks.listStateClientEvents.mockRejectedValue(
            new Error('client events not mocked')
        );
        mocks.listStateClientEventPage.mockRejectedValue(
            new Error('client event page not mocked')
        );
        mocks.listStateGroupEvents.mockRejectedValue(
            new Error('group events not mocked')
        );
        mocks.listStateGroupEventPage.mockRejectedValue(
            new Error('group event page not mocked')
        );
    });

    it('sends targeted channel JSON to explicit one-to-many peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const sent: RtcDataChannelSendResult = {
            status: 'sent',
            bufferedAmount: 0
        };
        const realtimeChannel = {
            sendJson: vi.fn(
                (_data: unknown, _options?: RtcDataChannelSendOptions) => sent
            )
        };
        const laneOpenRequests: Array<{
            readonly peerId: string;
            readonly laneId: string;
            readonly timeoutMs: number | undefined;
        }> = [];
        vi.mocked(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .mockImplementation(async (peerId, laneId = 'reliable', options) => {
                laneOpenRequests.push({
                    peerId,
                    laneId,
                    timeoutMs: options?.timeoutMs
                });
                if (peerId === 'peer-a') {
                    return {
                        status: 'open',
                        peerId,
                        laneId,
                        channel: toDataChannelTestDouble(realtimeChannel)
                    };
                }
                return {
                    status: 'timeout',
                    peerId,
                    laneId,
                    error: new Error('slow peer')
                };
            });

        const channel = createRallarFacade().channels.targeted<PositionUpdate>({
            peerIds: ['session-1', 'peer-a', 'peer-b', 'peer-a'],
            laneId: 'realtime',
            openTimeoutMs: 25
        });
        const result = await channel.send({
            x: 1
        });

        expect(result).toMatchObject({
            transport: 'rtc',
            status: 'partial',
            laneId: 'realtime',
            peerIds: ['peer-a', 'peer-b'],
            results: [
                {
                    peerId: 'peer-a',
                    result: sent
                },
                {
                    peerId: 'peer-b',
                    result: {
                        status: 'closed',
                        reason: 'Realtime lane not connected'
                    }
                }
            ]
        });
        expect(laneOpenRequests).toEqual([
            { peerId: 'peer-a', laneId: 'realtime', timeoutMs: 25 },
            { peerId: 'peer-b', laneId: 'realtime', timeoutMs: 25 }
        ]);
        expect(realtimeChannel.sendJson).toHaveBeenCalledWith(
            {
                x: 1
            },
            expect.objectContaining({})
        );
    });

    it('re-resolves live room targeted channel membership on each send', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const sent: RtcDataChannelSendResult = {
            status: 'sent',
            bufferedAmount: 0
        };
        const realtimeChannel = {
            sendJson: vi.fn(
                (_data: unknown, _options?: RtcDataChannelSendOptions) => sent
            )
        };
        vi.mocked(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .mockImplementation(
                async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                    status: 'open',
                    peerId,
                    laneId,
                    channel: toDataChannelTestDouble(realtimeChannel)
                })
            );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-a']));
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        });
        const channel = facade.channels.room<PositionUpdate>({
            roomId: 'room-1',
            laneId: 'realtime'
        });

        const first = await channel.send({
            x: 1
        });
        mockGroupSnapshot(
            createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b'])
        );
        const second = await channel.send({
            x: 2
        });

        expect(first.peerIds).toEqual(['peer-a']);
        expect(second.peerIds).toEqual(['peer-a', 'peer-b']);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-b',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 5_000
                })
            );
    });
});

function findLatestWsAnyMessageCallback() {
    return vi.mocked(mocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo)
        .mock.calls
        .filter(([callbackId]) => callbackId === 'rallar:ws:any-message')
        .at(-1)?.[1];
}

function toDataChannelTestDouble(
    members: Partial<QRtcDataChannel>
): QRtcDataChannel {
    return members as QRtcDataChannel;
}

function resetRepositoryDoublesToMissing(): void {
    mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
    mocks.getAllClientStateSnapshots.mockReturnValue([]);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
}

function resetMiddlewareDoublesToDefaults(): void {
    const { rtcRxStreamer, webRtcConnectionService, webSocketQueueBox } = mocks.ctx.middleware;
    vi.mocked(webRtcConnectionService.peerIdsWithNoReconnectableLanes).mockReset();
    vi.mocked(webRtcConnectionService.knownPeerIds).mockReset();
    vi.mocked(webRtcConnectionService.activePeerIds).mockReset();
    vi.mocked(webRtcConnectionService.readyPeerIdsForLane).mockReset();
    vi.mocked(webRtcConnectionService.ensurePeerConnectionStarted).mockReset();
    vi.mocked(webRtcConnectionService.ensurePeerLaneOpen).mockReset();
    vi.mocked(webRtcConnectionService.onRtcPeerLifecycleDo).mockReset();
    vi.mocked(webRtcConnectionService.readPeer).mockReset();
    vi.mocked(webRtcConnectionService.removeRtcPeerLifecycleById).mockReset();
    vi.mocked(rtcRxStreamer.enqueueOutboxIfAbsent).mockReset();
    vi.mocked(rtcRxStreamer.onInboxMessageDo).mockReset();
    vi.mocked(rtcRxStreamer.removeInboxMessageCallback).mockReset();
    vi.mocked(webSocketQueueBox.enqueueOutboxIfAbsent).mockReset();
    vi.mocked(webSocketQueueBox.onAnyInboxMessageDo).mockReset();
    vi.mocked(webSocketQueueBox.removeAnyInboxMessageCallback).mockReset();
    vi.mocked(webSocketQueueBox.readHealth).mockReset();
    vi.mocked(webSocketQueueBox.socket.onWebsocketCallbacksDo).mockReset();
    vi.mocked(webSocketQueueBox.socket.removeWebsocketCallbackById).mockReset();
    vi.mocked(webSocketQueueBox.close).mockImplementation((code, reason) => {
        webSocketQueueBox.socket.close(code, reason);
    });
}

function createChannelHealth(input: ChannelHealthFixtureInput) {
    return {
        peerId: input.peerId,
        label: input.label,
        state: input.state,
        role: 'Initiator',
        readyState: input.readyState,
        binaryType: 'arraybuffer' as const,
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        queuedItemCount: 0,
        rawCallbackCount: 0,
        messageCallbackCount: 0,
        lifecycleCallbackCount: 0,
        flowControl: {
            highWatermarkBytes: 64 * 1024,
            lowWatermarkBytes: 16 * 1024,
            overflow: 'drop-new' as const,
            maxQueueItems: 32
        },
        counters: {
            sent: 0,
            queued: 0,
            dropped: 0,
            replaced: 0,
            closed: 0,
            flushed: 0,
            droppedOldest: 0,
            droppedStale: 0,
            receivedRaw: 0,
            receivedString: 0,
            receivedBinary: 0
        }
    };
}

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.getAllGroupStateSnapshots.mockImplementation(() => [...snapshots]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) =>
        snapshots.find((snapshot) =>
            snapshot.group.groupId === ref.groupId &&
            snapshot.group.applicationId === ref.applicationId &&
            (snapshot.group.workspaceId ?? '') === (ref.workspaceId ?? '')
        )
    );
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshots.find((snapshot) => sessionId === snapshot.group.groupId)?.group
    );
}

function withSnapshotVersion(
    snapshot: GroupSnapshot,
    snapshotVersion: number
): GroupSnapshot {
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            snapshotVersion
        }
    };
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: GroupSnapshotFixtureScope = {}
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

function createMediaTrack(
    id: string,
    kind: 'audio' | 'video'
): MediaStreamTrack {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const track = {
        id,
        kind,
        enabled: true,
        readyState: 'live',
        addEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject
        ) => {
            if (type === 'ended') {
                listeners.add(listener);
            }
        }),
        removeEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject
        ) => {
            if (type === 'ended') {
                listeners.delete(listener);
            }
        }),
        stop: vi.fn(() => {
            track.readyState = 'ended';
            const event = { type: 'ended' } as Event;
            for (const listener of listeners) {
                if (typeof listener === 'function') {
                    listener(event);
                }
                else {
                    listener.handleEvent(event);
                }
            }
        })
    };

    return track as unknown as MediaStreamTrack;
}

function createMediaStream(
    id: string,
    tracks: readonly MediaStreamTrack[]
): MediaStream {
    return {
        id,
        active: tracks.some((track) => track.readyState !== 'ended'),
        getTracks: vi.fn(() => [...tracks]),
        getAudioTracks: vi.fn(() => tracks.filter((track) => track.kind === 'audio')),
        getVideoTracks: vi.fn(() => tracks.filter((track) => track.kind === 'video'))
    } as unknown as MediaStream;
}
