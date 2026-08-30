import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto } from '@shared/services/WebRtcConnectionService.ts';
import type { QRtcDataChannel, RtcDataChannelHealth } from '@shared/webrtc/QRtcDataChannel.ts';
import type { QRtcPeerConnection } from '@shared/webrtc/QRtcPeerConnection.ts';
import { vi } from 'vitest';
import type * as ContractModules from '../auth-session-contract-modules.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface ChannelHealthFixtureInput {
    readonly peerId: string;
    readonly label: string;
    readonly state: string;
    readonly readyState: RTCDataChannelState;
}

interface GroupSnapshotScopeFixture {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const CLIENT_REPOSITORY_MISSING_MESSAGE = 'Repository not found: shared.repository.client-state-snapshots';
const GROUP_REPOSITORY_MISSING_MESSAGE = 'Repository not found: shared.repository.group-state-snapshots';
const OVERLAY_REPOSITORY_MISSING_MESSAGE = 'Repository not found: shared.repository.accepted-overlays';

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        '../api-middleware-test-double.ts'
    );
    const ctx = createApiMiddlewareTestDouble();
    const throwClientRepositoryMissing = (): never => {
        throw new Error(CLIENT_REPOSITORY_MISSING_MESSAGE);
    };
    const throwGroupRepositoryMissing = (): never => {
        throw new Error(GROUP_REPOSITORY_MISSING_MESSAGE);
    };
    const throwOverlayRepositoryMissing = (): never => {
        throw new Error(OVERLAY_REPOSITORY_MISSING_MESSAGE);
    };

    return {
        ctx,
        webRtcConnectionService: vi.mocked(ctx.middleware.webRtcConnectionService),
        rtcRxStreamer: vi.mocked(ctx.middleware.rtcRxStreamer),
        webSocketQueueBox: vi.mocked(ctx.middleware.webSocketQueueBox),
        webSocketClient: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
        clearSession: vi.fn<ContractModules.Auth['clearSession']>(),
        hydrateStateCache: vi.fn<ContractModules.StateCacheLifecycle['browserStateCacheLifecycle']['hydrate']>(() => Promise.resolve()),
        initialiseApiMiddleware: vi.fn<ContractModules.BrowserTransportRuntime['init']>(() => Promise.resolve(ctx)),
        createAndJoinStateGroup: vi.fn<ContractModules.RoomGroupStateWorkflows['createAndJoinStateGroup']>(
            () => Promise.reject(new Error('create not mocked'))
        ),
        joinStateGroup: vi.fn<ContractModules.RoomGroupStateWorkflows['joinStateGroup']>(
            () => Promise.reject(new Error('join not mocked'))
        ),
        leaveStateGroup: vi.fn<ContractModules.RoomGroupStateWorkflows['leaveStateGroup']>(
            () => Promise.reject(new Error('leave not mocked'))
        ),
        updateStateGroupMetadata: vi.fn<ContractModules.RoomMutationWorkflows['updateStateGroupMetadata']>(
            () => Promise.reject(new Error('metadata update not mocked'))
        ),
        loginToApi: vi.fn<ContractModules.AuthApi['loginToApi']>(() => Promise.resolve(ctx.session)),
        listStateClientEvents: vi.fn<ContractModules.StateEventHttpApi['listStateClientEvents']>(
            () => Promise.reject(new Error('client events not mocked'))
        ),
        listStateClientEventPage: vi.fn<ContractModules.StateEventHttpApi['listStateClientEventPage']>(
            () => Promise.reject(new Error('client event page not mocked'))
        ),
        listStateGroupEvents: vi.fn<ContractModules.StateEventHttpApi['listStateGroupEvents']>(
            () => Promise.reject(new Error('group events not mocked'))
        ),
        listStateGroupEventPage: vi.fn<ContractModules.StateEventHttpApi['listStateGroupEventPage']>(
            () => Promise.reject(new Error('group event page not mocked'))
        ),
        logoutFromApi: vi.fn<ContractModules.AuthApi['logoutFromApi']>(
            () => Promise.resolve({ loggedOut: true })
        ),
        registerWithApi: vi.fn<ContractModules.AuthApi['registerWithApi']>(() =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            })
        ),
        onCacheChange: vi.fn<ContractModules.StateCacheLifecycle['browserStateCacheLifecycle']['onChange']>(() => vi.fn()),
        readSession: vi.fn<ContractModules.Auth['readSession']>(() => ctx.session),
        refreshStateSnapshots: vi.fn<ContractModules.RefreshStateSnapshots['refreshStateSnapshots']>(
            () => Promise.resolve({ clients: [], groups: [] })
        ),
        findClientStateSnapshotByPrincipalId: vi.fn<ContractModules.ClientStateSnapshotsRepository['findClientStateSnapshotByPrincipalId']>(
            throwClientRepositoryMissing
        ),
        getAllClientStateSnapshots: vi.fn<ContractModules.ClientStateSnapshotsRepository['getAllClientStateSnapshots']>(throwClientRepositoryMissing),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<ContractModules.GroupStateSnapshotsRepository['findFirstGroupStateSnapshotRefSessionIdIsIn']>(
            throwGroupRepositoryMissing
        ),
        findGroupStateSnapshotByRef: vi.fn<ContractModules.GroupStateSnapshotsRepository['findGroupStateSnapshotByRef']>(throwGroupRepositoryMissing),
        getAllGroupStateSnapshots: vi.fn<ContractModules.GroupStateSnapshotsRepository['getAllGroupStateSnapshots']>(throwGroupRepositoryMissing),
        findAcceptedOverlayById: vi.fn<ContractModules.OverlaysRepository['findAcceptedOverlayById']>(throwOverlayRepositoryMissing),
        writeSession: vi.fn<ContractModules.Auth['writeSession']>()
    };
});

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    (): Partial<ContractModules.BrowserMiddlewareModule> => ({
        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
    })
);

vi.mock(
    import('@shared-web/browser/state-read/state-event-http-api.ts'),
    (): Partial<ContractModules.StateEventHttpApi> => ({
        listStateClientEventPage: mocks.listStateClientEventPage,
        listStateClientEvents: mocks.listStateClientEvents,
        listStateGroupEventPage: mocks.listStateGroupEventPage,
        listStateGroupEvents: mocks.listStateGroupEvents
    })
);

vi.mock(
    import('@shared-web/browser/auth/session-http-api.ts'),
    (): Partial<ContractModules.AuthApi> => ({
        loginToApi: mocks.loginToApi,
        logoutFromApi: mocks.logoutFromApi,
        registerWithApi: mocks.registerWithApi
    })
);

vi.mock(import('@shared-web/browser/rooms/room-group-state-workflows.ts'), (): Partial<ContractModules.RoomGroupStateWorkflows> => ({
    createAndJoinStateGroup: mocks.createAndJoinStateGroup,
    joinStateGroup: mocks.joinStateGroup,
    leaveStateGroup: mocks.leaveStateGroup
}));
vi.mock(import('@shared-web/browser/state-read/refresh-state-snapshots.ts'), (): Partial<ContractModules.RefreshStateSnapshots> => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots
}));
vi.mock(import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'), (): Partial<ContractModules.RoomMutationWorkflows> => ({
    updateStateGroupMetadata: mocks.updateStateGroupMetadata
}));

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<ContractModules.StateCacheLifecycle> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn()
        }
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<ContractModules.Auth> => ({
    clearSession: mocks.clearSession,
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: mocks.writeSession
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ContractModules.ClientStateSnapshotsRepository> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<ContractModules.GroupStateSnapshotsRepository> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
    })
);

vi.mock(import('@shared/repository/overlays-repository.ts'), async (importOriginal) => ({
    ...await importOriginal(),
    findAcceptedOverlayById: mocks.findAcceptedOverlayById
}));

export function readRtcWaitMocks(): typeof mocks {
    return mocks;
}

export async function resetRtcWaitTestRuntime(): Promise<void> {
    (await import('@shared-web/browser/connection/browser-transport-runtime.ts'))
        .browserTransportRuntime.shutdown('test-reset');
    vi.clearAllMocks();
    vi.useRealTimers();
    mockClientRepositoryMissing();
    mockGroupRepositoryMissing();
    mocks.findAcceptedOverlayById.mockReturnValue(undefined);
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
    mocks.onCacheChange.mockImplementation(() => vi.fn());
    resetRtcConnectionMocks();
    resetRtcTransportMocks();
    mocks.registerWithApi.mockResolvedValue({
        clientId: 'client-new',
        username: 'new-user',
        displayName: null,
        registeredAtEpochMs: 1_000
    });
    mocks.listStateClientEvents.mockRejectedValue(new Error('client events not mocked'));
    mocks.listStateClientEventPage.mockRejectedValue(new Error('client event page not mocked'));
    mocks.listStateGroupEvents.mockRejectedValue(new Error('group events not mocked'));
    mocks.listStateGroupEventPage.mockRejectedValue(new Error('group event page not mocked'));
}

function resetRtcConnectionMocks(): void {
    mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes.mockReturnValue([]);
    mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
    mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
    mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
    mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
        (peerId) =>
            Either.ofLeft({
                kind: 'connect-failed',
                peerId,
                error: new Error('connect not mocked')
            })
    );
    mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
        async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
            status: 'connect-failed',
            peerId,
            laneId,
            error: new Error('connect not mocked')
        })
    );
    mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(
        () => mocks.webRtcConnectionService
    );
    mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
    mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
}

function resetRtcTransportMocks(): void {
    mocks.rtcRxStreamer.onInboxMessageDo.mockReturnValue(mocks.rtcRxStreamer);
    mocks.rtcRxStreamer.removeInboxMessageCallback.mockReturnValue(true);
    mocks.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(mocks.webSocketQueueBox);
    mocks.webSocketQueueBox.removeAnyInboxMessageCallback.mockReturnValue(true);
    mocks.webSocketQueueBox.readHealth.mockReturnValue({
        sessionId: mocks.ctx.session.sessionId,
        url: 'ws://localhost/ws',
        readyState: 'missing',
        isOpen: false,
        reconnecting: false,
        reconnectEnabled: false,
        reconnectAttempts: 0,
        maxReconnectAttempts: 12,
        reconnectExhausted: false
    });
    mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
        mocks.webSocketClient.close(code, reason);
    });
    mocks.webSocketClient.onWebsocketCallbacksDo.mockReturnValue(mocks.webSocketClient);
    mocks.webSocketClient.removeWebsocketCallbackById.mockReturnValue(true);
}

export function toTestDouble<TValue>(members: Partial<TValue>): TValue {
    return members as TValue;
}

export function createPeerTestDouble(
    peerId: string,
    channels: readonly (readonly [string, Partial<QRtcDataChannel>])[],
    connectionStatus: Partial<QRtcPeerConnection['status']> = {}
): QRtcPeerDto {
    return toTestDouble<QRtcPeerDto>({
        peerId,
        connection: toTestDouble<QRtcPeerConnection>({
            status: toTestDouble<QRtcPeerConnection['status']>({
                iceCandidateQueue: [],
                remoteStreams: new Map(),
                makingOffer: false,
                ignoreOffer: false,
                ...connectionStatus
            })
        }),
        channels: new Map(
            channels.map(([laneId, channel]) => [laneId, toTestDouble<QRtcDataChannel>(channel)] as const)
        )
    });
}

export function createChannelHealth(
    input: ChannelHealthFixtureInput
): RtcDataChannelHealth {
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

function mockClientRepositoryMissing(): void {
    mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
    mocks.getAllClientStateSnapshots.mockReturnValue([]);
}

function mockGroupRepositoryMissing(): void {
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
}

export function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

export function mockAcceptedOverlay(
    snapshot: GroupSnapshot,
    nextHopSessionIds: readonly string[]
): void {
    mocks.findAcceptedOverlayById.mockImplementation((overlayId) =>
        overlayId === toScopedOverlayId(snapshot.group)
            ? createAcceptedOverlay(snapshot, nextHopSessionIds)
            : undefined
    );
}

export function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.getAllGroupStateSnapshots.mockImplementation(() => [...snapshots]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) =>
        snapshots.find(
            (snapshot) =>
                snapshot.group.groupId === ref.groupId &&
                snapshot.group.applicationId === ref.applicationId &&
                (snapshot.group.workspaceId ?? '') === (ref.workspaceId ?? '')
        )
    );
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation(
        (sessionId) =>
            snapshots.find((snapshot) =>
                snapshot.activeSessions.some(
                    (activeSession) => activeSession.sessionId === sessionId
                )
            )?.group
    );
    mocks.findAcceptedOverlayById.mockImplementation((overlayId) => {
        const snapshot = snapshots.find(
            (candidate) => toScopedOverlayId(candidate.group) === overlayId
        );
        return snapshot ? createAcceptedOverlay(snapshot) : undefined;
    });
}

export function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: GroupSnapshotScopeFixture = {}
): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: scope.applicationId ?? 'app-1',
        workspaceId: scope.workspaceId ?? 'workspace-1',
        groupId,
        sessionIds
    });
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            acceptedLayoutIdentity: {
                ...snapshot.causalRevision,
                version: 1,
                state: 'active'
            }
        }
    };
}

function createAcceptedOverlay(
    snapshot: GroupSnapshot,
    nextHopSessionIds: readonly string[] = snapshot.activeSessions.map(({ sessionId }) => sessionId)
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: snapshot.causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(snapshot.group),
        groupRef: snapshot.group,
        topology: 'tree',
        name: snapshot.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: [...nextHopSessionIds],
        degreeLimit: 2,
        overlayVersion: 1,
        updatedAtEpochMs: 1
    };
}
