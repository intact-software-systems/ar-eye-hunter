import { vi } from 'vitest';

import type { StateSnapshots } from '@shared-web/browser/api-workflows.ts';
import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { Middleware } from '@shared-web/browser/middleware.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import { createActiveClientSessionFixture, createClientSnapshotFixture, createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

export interface PeopleEventFixtureInput {
    readonly principalId: string;
    readonly eventId: string;
    readonly eventType: ClientEvent['eventType'];
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly snapshotVersion?: number;
    readonly occurredAtEpochMs?: number;
}

const peopleEventMocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    const context = createApiMiddlewareTestDouble();

    return {
        session: context.session,
        context,
        hydrateStateCaches: vi.fn(async (): Promise<void> => undefined),
        initMiddleware: vi.fn(async (): Promise<ApiMiddleware> => context),
        isMiddlewareReady: vi.fn(() => false),
        listStateClientEvents: vi.fn(async (_principalId: string): Promise<ClientEvent[]> => []),
        listStateClientEventPage: vi.fn(
            async (_principalId: string): Promise<StateEventPage<ClientEvent>> => ({
                events: [],
                hasMore: false
            })
        ),
        refreshStateSnapshots: vi.fn(async (): Promise<StateSnapshots> => ({
            clients: [],
            groups: []
        })),
        findClientStateSnapshotByPrincipalId: vi.fn(() => undefined),
        getAllClientStateSnapshots: vi.fn(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn(() => undefined),
        findGroupStateSnapshotByRef: vi.fn(() => undefined),
        getAllGroupStateSnapshots: vi.fn(() => [])
    };
});

vi.mock(import('@shared-web/browser/middleware.ts'), () => ({
    initialiseMiddleware: async (): Promise<Middleware> => peopleEventMocks.context.middleware
}));

vi.mock(import('@shared-web/browser/api-integration.ts'), () => ({
    listStateClientEventPage: peopleEventMocks.listStateClientEventPage,
    listStateClientEvents: peopleEventMocks.listStateClientEvents,
    listStateGroupEventPage: vi.fn(),
    listStateGroupEvents: vi.fn()
}));

vi.mock(import('@shared-web/browser/api-workflows.ts'), () => ({
    refreshStateSnapshots: peopleEventMocks.refreshStateSnapshots
}));

vi.mock(import('@shared-web/browser/data-caches.ts'), () => ({
    hydrateStateCaches: peopleEventMocks.hydrateStateCaches,
    onStateCacheChange: vi.fn(() => vi.fn())
}));

vi.mock(import('@shared/api/auth.ts'), () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: vi.fn(() => peopleEventMocks.session),
    writeSession: vi.fn()
}));

vi.mock(import('@shared/repository/client-state-snapshots-repository.ts'), () => ({
    findClientStateSnapshotByPrincipalId: peopleEventMocks.findClientStateSnapshotByPrincipalId,
    getAllClientStateSnapshots: peopleEventMocks.getAllClientStateSnapshots
}));

vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: peopleEventMocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotByRef: peopleEventMocks.findGroupStateSnapshotByRef,
    getAllGroupStateSnapshots: peopleEventMocks.getAllGroupStateSnapshots
}));

export function readPeopleEventMocks(): typeof peopleEventMocks {
    return peopleEventMocks;
}

export function resetPeopleEventTestRuntime(): void {
    vi.clearAllMocks();
    peopleEventMocks.hydrateStateCaches.mockResolvedValue(undefined);
    peopleEventMocks.initMiddleware.mockResolvedValue(peopleEventMocks.context);
    peopleEventMocks.isMiddlewareReady.mockReturnValue(false);
    peopleEventMocks.listStateClientEvents.mockRejectedValue(new Error('client events not mocked'));
    peopleEventMocks.listStateClientEventPage.mockRejectedValue(
        new Error('client event page not mocked')
    );
    peopleEventMocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
    const { webSocketQueueBox, webRtcConnectionService } = peopleEventMocks.context.middleware;
    vi.mocked(webSocketQueueBox.close).mockImplementation((code, reason) => {
        webSocketQueueBox.socket.close(code, reason);
    });
    vi.mocked(webSocketQueueBox.onAnyInboxMessageDo).mockReturnValue(webSocketQueueBox);
    vi.mocked(webSocketQueueBox.removeAnyInboxMessageCallback).mockReturnValue(true);
    vi.mocked(webRtcConnectionService.onRtcPeerLifecycleDo).mockReturnValue(webRtcConnectionService);
}

export function findPeopleWsCallback(
    latest = false
): { onMessage?: (message: unknown) => Promise<void>; } | undefined {
    const calls = vi
        .mocked(peopleEventMocks.context.middleware.webSocketQueueBox.onAnyInboxMessageDo)
        .mock.calls.filter(([callbackId]) => callbackId === 'rallar:ws:any-message');
    const call = latest ? calls.at(-1) : calls[0];
    return call?.[1] as { onMessage?: (message: unknown) => Promise<void>; } | undefined;
}

export function toPeopleEventMessage(event: ClientEvent) {
    return newALBroadcastMessage(
        'server-1',
        newALEventRoute(AppTopics.clientStateEvent, event.principalId, event.eventId),
        'all',
        AppTopics.clientStateEvent,
        event
    );
}

export function createPeopleEvent(
    input: PeopleEventFixtureInput
): ClientEvent {
    const { principalId, eventId, eventType } = input;
    return {
        applicationId: input.applicationId ?? 'app-1',
        workspaceId: input.workspaceId ?? 'workspace-1',
        principalId,
        eventId,
        eventType,
        clientInstanceId: `${principalId}-instance`,
        sessionId: `${principalId}-session`,
        snapshotVersion: input.snapshotVersion ?? 1,
        occurredAtEpochMs: input.occurredAtEpochMs ?? 1,
        actor: {
            kind: 'session',
            principalId,
            sessionId: `${principalId}-session`
        },
        reason: null,
        traceId: null,
        requestId: `request-${eventId}`,
        payload: {}
    };
}

export function createPeopleEventPage(
    events: readonly ClientEvent[],
    hasMore: boolean
): StateEventPage<ClientEvent> {
    const last = events.at(-1);
    return {
        events,
        nextCursor: last
            ? {
                snapshotVersion: last.snapshotVersion,
                occurredAtEpochMs: last.occurredAtEpochMs,
                eventId: last.eventId
            }
            : undefined,
        hasMore
    };
}

export function createPeopleSnapshot(principalId: string, sessionId: string): ClientSnapshot {
    const snapshot = createClientSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId
    });
    return {
        ...snapshot,
        activeSessions: [
            createActiveClientSessionFixture({
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId,
                clientInstanceId: `${principalId}-instance`,
                sessionId
            })
        ],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: 1
    };
}

export function createPeopleRoomSnapshot(
    groupId: string,
    sessionIds: readonly string[]
): GroupSnapshot {
    return createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        sessionIds
    });
}
