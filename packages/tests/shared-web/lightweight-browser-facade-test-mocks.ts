import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { MiddlewareInitOptions } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { vi } from 'vitest';
import { createApiMiddlewareTestDouble } from './api-middleware-test-double.ts';

type StateEventHttpApiModule = typeof import('@shared-web/browser/state-read/state-event-http-api.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type AppointRoomDirectorModule = typeof import('@shared-web/browser/director/appoint-room-director.ts');
type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');
type RoomMutationWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type ClientRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

export function createLightweightBrowserFacadeTestMocks() {
    const ctx = createApiMiddlewareTestDouble();
    return {
        ctx,
        heartbeat: vi.mocked(ctx.middleware.heartbeat),
        qboxEngine: vi.mocked(ctx.middleware.qboxEngine),
        rtcRxStreamer: vi.mocked(ctx.middleware.rtcRxStreamer),
        webRtcConnectionService: vi.mocked(ctx.middleware.webRtcConnectionService),
        webSocketQueueBox: vi.mocked(ctx.middleware.webSocketQueueBox),
        webSocket: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
        clientRepositoryMissing: vi.fn((): never => missingRepository('shared.repository.client-state-snapshots')),
        appointStateGroupDirector: rejectedWorkflow<AppointRoomDirectorModule['appointStateGroupDirector']>('director appointment not mocked'),
        ...createLifecycleMocks(ctx),
        ...createWorkflowMocks(),
        ...createRepositoryMocks()
    };
}

function createLifecycleMocks(ctx: ApiMiddleware) {
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

function createWorkflowMocks() {
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

function createRepositoryMocks() {
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
        getAllGroupStateSnapshots: vi.fn<GroupRepositoryModule['getAllGroupStateSnapshots']>(() => missingRepository('shared.repository.group-state-snapshots'))
    };
}

function rejectedWorkflow<T extends (...input: never[]) => Promise<object | undefined>>(
    message: string
) {
    return vi.fn<T>().mockRejectedValue(new Error(message));
}

function missingRepository(name: string): never {
    throw new Error(`Repository not found: ${name}`);
}
