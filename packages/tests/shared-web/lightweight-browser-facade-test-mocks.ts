import type { MiddlewareInitOptions } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { vi, type Mock, type Mocked } from 'vitest';
import { createDefaultApiMiddlewareTestDouble } from './api-middleware-test-double.ts';

type StateEventHttpApiModule = typeof import('@shared-web/browser/state-read/state-event-http-api.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type AppointRoomDirectorModule = typeof import('@shared-web/browser/director/appoint-room-director.ts');
type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');
type RoomMutationWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type ClientRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');
type OverlaysRepositoryModule = typeof import('@shared/repository/overlays-repository.ts');

interface BrowserLifecycleMocks {
    readonly clearSession: Mock<() => void>;
    readonly hydrateStateCache: Mock<() => Promise<void>>;
    readonly initialiseApiMiddleware: Mock<(options?: MiddlewareInitOptions) => Promise<ApiMiddleware>>;
    readonly loginToApi: Mock<AuthApiModule['loginToApi']>;
    readonly logoutFromApi: Mock<AuthApiModule['logoutFromApi']>;
    readonly registerWithApi: Mock<AuthApiModule['registerWithApi']>;
    readonly onCacheChange: Mock<() => () => void>;
    readonly readSession: Mock<() => ApiMiddleware['session']>;
    readonly writeSession: Mock<() => void>;
}

interface BrowserWorkflowMocks {
    readonly createAndJoinStateGroup: Mock<RoomGroupStateWorkflowsModule['createAndJoinStateGroup']>;
    readonly joinStateGroup: Mock<RoomGroupStateWorkflowsModule['joinStateGroup']>;
    readonly leaveStateGroup: Mock<RoomGroupStateWorkflowsModule['leaveStateGroup']>;
    readonly updateStateGroupMetadata: Mock<RoomMutationWorkflowsModule['updateStateGroupMetadata']>;
    readonly refreshStateSnapshots: Mock<RefreshStateSnapshotsModule['refreshStateSnapshots']>;
    readonly listStateClientEvents: Mock<StateEventHttpApiModule['listStateClientEvents']>;
    readonly listStateClientEventPage: Mock<StateEventHttpApiModule['listStateClientEventPage']>;
    readonly listStateGroupEvents: Mock<StateEventHttpApiModule['listStateGroupEvents']>;
    readonly listStateGroupEventPage: Mock<StateEventHttpApiModule['listStateGroupEventPage']>;
}

interface BrowserRepositoryMocks {
    readonly findClientStateSnapshotByPrincipalId: Mock<ClientRepositoryModule['findClientStateSnapshotByPrincipalId']>;
    readonly getAllClientStateSnapshots: Mock<ClientRepositoryModule['getAllClientStateSnapshots']>;
    readonly findFirstGroupStateSnapshotRefSessionIdIsIn: Mock<GroupRepositoryModule['findFirstGroupStateSnapshotRefSessionIdIsIn']>;
    readonly findGroupStateSnapshotByRef: Mock<GroupRepositoryModule['findGroupStateSnapshotByRef']>;
    readonly getAllGroupStateSnapshots: Mock<GroupRepositoryModule['getAllGroupStateSnapshots']>;
    readonly findAcceptedOverlayById: Mock<OverlaysRepositoryModule['findAcceptedOverlayById']>;
}

export interface LightweightBrowserFacadeTestMocks extends BrowserLifecycleMocks, BrowserWorkflowMocks, BrowserRepositoryMocks {
    readonly ctx: ApiMiddleware;
    readonly heartbeat: Mocked<ApiMiddleware['middleware']['heartbeat']>;
    readonly qboxEngine: Mocked<ApiMiddleware['middleware']['qboxEngine']>;
    readonly rtcRxStreamer: Mocked<ApiMiddleware['middleware']['rtcRxStreamer']>;
    readonly webRtcConnectionService: Mocked<ApiMiddleware['middleware']['webRtcConnectionService']>;
    readonly webSocketQueueBox: Mocked<ApiMiddleware['middleware']['webSocketQueueBox']>;
    readonly webSocket: Mocked<ApiMiddleware['middleware']['webSocketQueueBox']['socket']>;
    readonly appointStateGroupDirector: Mock<AppointRoomDirectorModule['appointStateGroupDirector']>;
}

export function createLightweightBrowserFacadeTestMocks(): LightweightBrowserFacadeTestMocks {
    const ctx = createDefaultApiMiddlewareTestDouble();
    return {
        ctx,
        heartbeat: vi.mocked(ctx.middleware.heartbeat),
        qboxEngine: vi.mocked(ctx.middleware.qboxEngine),
        rtcRxStreamer: vi.mocked(ctx.middleware.rtcRxStreamer),
        webRtcConnectionService: vi.mocked(ctx.middleware.webRtcConnectionService),
        webSocketQueueBox: vi.mocked(ctx.middleware.webSocketQueueBox),
        webSocket: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
        appointStateGroupDirector: rejectedWorkflow<AppointRoomDirectorModule['appointStateGroupDirector']>('director appointment not mocked'),
        ...createLifecycleMocks(ctx),
        ...createWorkflowMocks(),
        ...createRepositoryMocks()
    };
}

function createLifecycleMocks(ctx: ApiMiddleware): BrowserLifecycleMocks {
    return {
        clearSession: vi.fn(),
        hydrateStateCache: vi.fn((): Promise<void> => Promise.resolve()),
        initialiseApiMiddleware: vi.fn((_options?: MiddlewareInitOptions) => Promise.resolve(ctx)),
        loginToApi: vi.fn<AuthApiModule['loginToApi']>(() => Promise.resolve(ctx.session)),
        logoutFromApi: vi.fn<AuthApiModule['logoutFromApi']>(() => Promise.resolve({ loggedOut: true })),
        registerWithApi: vi.fn<AuthApiModule['registerWithApi']>(() =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            })
        ),
        onCacheChange: vi.fn((): () => void => vi.fn()),
        readSession: vi.fn(() => ctx.session),
        writeSession: vi.fn()
    };
}

function createWorkflowMocks(): BrowserWorkflowMocks {
    return {
        createAndJoinStateGroup: rejectedWorkflow<RoomGroupStateWorkflowsModule['createAndJoinStateGroup']>(
            'create not mocked'
        ),
        joinStateGroup: rejectedWorkflow<RoomGroupStateWorkflowsModule['joinStateGroup']>(
            'join not mocked'
        ),
        leaveStateGroup: rejectedWorkflow<RoomGroupStateWorkflowsModule['leaveStateGroup']>(
            'leave not mocked'
        ),
        updateStateGroupMetadata: rejectedWorkflow<RoomMutationWorkflowsModule['updateStateGroupMetadata']>('metadata update not mocked'),
        refreshStateSnapshots: vi.fn<RefreshStateSnapshotsModule['refreshStateSnapshots']>(
            () => Promise.resolve({ clients: [], groups: [] })
        ),
        listStateClientEvents: rejectedWorkflow<StateEventHttpApiModule['listStateClientEvents']>('client events not mocked'),
        listStateClientEventPage: rejectedWorkflow<StateEventHttpApiModule['listStateClientEventPage']>('client event page not mocked'),
        listStateGroupEvents: rejectedWorkflow<StateEventHttpApiModule['listStateGroupEvents']>('group events not mocked'),
        listStateGroupEventPage: rejectedWorkflow<StateEventHttpApiModule['listStateGroupEventPage']>('group event page not mocked')
    };
}

function createRepositoryMocks(): BrowserRepositoryMocks {
    return {
        findClientStateSnapshotByPrincipalId: vi.fn<ClientRepositoryModule['findClientStateSnapshotByPrincipalId']>(() =>
            missingRepository('shared.repository.client-state-snapshots')
        ),
        getAllClientStateSnapshots: vi.fn<ClientRepositoryModule['getAllClientStateSnapshots']>(() =>
            missingRepository('shared.repository.client-state-snapshots')
        ),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<GroupRepositoryModule['findFirstGroupStateSnapshotRefSessionIdIsIn']>(() =>
            missingRepository('shared.repository.group-state-snapshots')
        ),
        findGroupStateSnapshotByRef: vi.fn<GroupRepositoryModule['findGroupStateSnapshotByRef']>(() =>
            missingRepository('shared.repository.group-state-snapshots')
        ),
        getAllGroupStateSnapshots: vi.fn<GroupRepositoryModule['getAllGroupStateSnapshots']>(() =>
            missingRepository('shared.repository.group-state-snapshots')
        ),
        findAcceptedOverlayById: vi.fn<OverlaysRepositoryModule['findAcceptedOverlayById']>(() => missingRepository('shared.repository.accepted-overlays'))
    };
}

function rejectedWorkflow<T extends (...input: never[]) => Promise<object | undefined>>(
    message: string
): Mock<T> {
    return vi.fn<T>().mockRejectedValue(new Error(message));
}

function missingRepository(name: string): never {
    throw new Error(`Repository not found: ${name}`);
}
