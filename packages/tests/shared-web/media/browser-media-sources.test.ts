import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedMediaStream, SimulatedMediaTrack } from '../../shared/native-rtc-media-fixture.ts';

type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type StateEventHttpApiModule = typeof import('@shared-web/browser/state-read/state-event-http-api.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');
type RoomMutationWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');
const mocks = await vi.hoisted(async () => {
    const { createLightweightBrowserFacadeTestMocks } = await import(
        '../lightweight-browser-facade-test-mocks.ts'
    );
    return createLightweightBrowserFacadeTestMocks();
});

vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), (): Partial<MiddlewareModule> => ({
    initialiseMiddleware: async () => (await mocks.initialiseApiMiddleware()).middleware
}));

vi.mock(
    import('@shared-web/browser/state-read/state-event-http-api.ts'),
    (): Partial<StateEventHttpApiModule> => ({
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

vi.mock(import('@shared-web/browser/rooms/room-group-state-workflows.ts'), (): Partial<RoomGroupStateWorkflowsModule> => ({
    createAndJoinStateGroup: mocks.createAndJoinStateGroup,
    joinStateGroup: mocks.joinStateGroup,
    leaveStateGroup: mocks.leaveStateGroup
}));
vi.mock(import('@shared-web/browser/state-read/refresh-state-snapshots.ts'), (): Partial<RefreshStateSnapshotsModule> => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots
}));
vi.mock(import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'), (): Partial<RoomMutationWorkflowsModule> => ({
    updateStateGroupMetadata: mocks.updateStateGroupMetadata
}));

vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), (): Partial<StateCacheLifecycleModule> => ({
    browserStateCacheLifecycle: {
        hydrate: mocks.hydrateStateCache,
        onChange: mocks.onCacheChange,
        initialise: vi.fn(),
        cancelSnapshotAssemblies: vi.fn(() => undefined)
    }
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

describe('Rallar media sources', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        resetRepositoryDoublesToMissing();
        resetMiddlewareDoublesToDefaults();
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.initialiseApiMiddleware.mockResolvedValue(mocks.ctx);
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

    it('starts a media-only call without opening data lanes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const stream = new SimulatedMediaStream('local-stream-1', []);
        const laneOpenRequests: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = 'reliable') => {
                laneOpenRequests.push(`${peerId}:${laneId}`);
                return {
                    status: 'connect-failed',
                    peerId,
                    laneId,
                    error: new Error('unexpected data-lane open')
                };
            }
        );

        const call = await createRallarFacade().calls.start({
            peerIds: ['peer-1'],
            media: {
                stream,
                audio: true,
                video: false
            }
        });
        const ended = await call.end();

        expect(mocks.ctx.middleware.rtcRxStreamer.setLocalMediaStream)
            .toHaveBeenCalledWith(stream);
        expect(mocks.ctx.middleware.rtcRxStreamer.setLocalAudioEnabled)
            .toHaveBeenCalledWith(true);
        expect(mocks.ctx.middleware.rtcRxStreamer.setLocalVideoEnabled)
            .toHaveBeenCalledWith(false);
        expect(mocks.webRtcConnectionService.ensurePeerConnectionStarted)
            .toHaveBeenCalledWith('peer-1');
        expect(laneOpenRequests).toEqual([]);
        expect(mocks.ctx.middleware.rtcRxStreamer.stopLocalMedia)
            .toHaveBeenCalledWith('all');
        expect(ended).toMatchObject({
            state: 'ended',
            media: {
                audioEnabled: false,
                videoEnabled: false
            }
        });
    });

    it('starts microphone and camera sources separately and attaches a composed stream', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const audioTrack = new SimulatedMediaTrack('audio', 'audio-track-1');
        const videoTrack = new SimulatedMediaTrack('video', 'video-track-1');
        const microphoneStream = new SimulatedMediaStream('microphone-stream', [
            audioTrack
        ]);
        const cameraStream = new SimulatedMediaStream('camera-stream', [videoTrack]);
        const facade = createRallarFacade();

        const microphone = await facade.media.microphone.start({
            stream: microphoneStream
        });
        const camera = await facade.media.camera.start({
            stream: cameraStream
        });
        const cameraDisabled = await camera.setEnabled(false);
        const lastAttachedStream = vi.mocked(
            mocks.ctx.middleware.rtcRxStreamer.setLocalMediaStream
        ).mock.calls.at(-1)?.[0];

        expect(microphone.status()).toMatchObject({
            kind: 'microphone',
            state: 'open',
            streamId: 'microphone-stream',
            audioTrackIds: ['audio-track-1']
        });
        expect(cameraDisabled).toMatchObject({
            kind: 'camera',
            enabledTrackIds: [],
            videoTrackIds: ['video-track-1']
        });
        expect(videoTrack.enabled).toBe(false);
        expect(lastAttachedStream?.getTracks().map((track) => track.id))
            .toEqual(['audio-track-1', 'video-track-1']);
        expect(microphone.status().enabledTrackIds).toEqual(['audio-track-1']);
    });

    it('exposes call source handles for screen sharing without opening data lanes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const screenTrack = new SimulatedMediaTrack('video', 'screen-track-1');
        const screenStream = new SimulatedMediaStream('screen-stream', [screenTrack]);
        const laneOpenRequests: string[] = [];
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = 'reliable') => {
                laneOpenRequests.push(`${peerId}:${laneId}`);
                return {
                    status: 'connect-failed',
                    peerId,
                    laneId,
                    error: new Error('unexpected data-lane open')
                };
            }
        );
        const facade = createRallarFacade();

        const call = await facade.calls.start({
            peerIds: ['peer-1'],
            media: {}
        });
        const screen = await call.sources.screen.start({
            stream: screenStream
        });
        const statusWithScreen = call.status();
        const stopped = await screen.stop();

        expect(mocks.webRtcConnectionService.ensurePeerConnectionStarted)
            .toHaveBeenCalledWith('peer-1');
        expect(laneOpenRequests).toEqual([]);
        expect(statusWithScreen.media.sources).toEqual([
            expect.objectContaining({
                kind: 'screen',
                state: 'open',
                streamId: 'screen-stream',
                videoTrackIds: ['screen-track-1']
            })
        ]);
        expect(stopped).toMatchObject({
            kind: 'screen',
            state: 'ended'
        });
        expect(screenTrack.readyState).toBe('ended');
        expect(mocks.ctx.middleware.rtcRxStreamer.stopLocalMedia)
            .toHaveBeenCalledWith('all');
    });
});

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
