import { vi } from 'vitest';

import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { Middleware } from '@shared-web/browser/middleware.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

type StateEventHttpApiModule = typeof import('@shared-web/browser/state-read/state-event-http-api.ts');

export interface RoomEventFixtureInput {
    readonly groupId: string;
    readonly eventId: string;
    readonly eventType: GroupEvent['eventType'];
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly snapshotVersion?: number;
    readonly occurredAtEpochMs?: number;
}

const roomEventMocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    const ctx = createApiMiddlewareTestDouble();

    return {
        session: ctx.session,
        ctx,
        hydrateStateCaches: vi.fn(async (): Promise<void> => undefined),
        initMiddleware: vi.fn(async (): Promise<ApiMiddleware> => ctx),
        isMiddlewareReady: vi.fn(() => false),
        listStateGroupEvents: vi.fn(async (_groupId: string): Promise<GroupEvent[]> => []),
        listStateGroupEventPage: vi.fn<StateEventHttpApiModule['listStateGroupEventPage']>(
            async (): Promise<StateEventPage<GroupEvent>> => ({
                events: [],
                hasMore: false
            })
        ),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn(() => undefined),
        findGroupStateSnapshotByRef: vi.fn(() => undefined),
        getAllGroupStateSnapshots: vi.fn(() => [])
    };
});

vi.mock(import('@shared-web/browser/middleware.ts'), () => ({
    initialiseMiddleware: async (): Promise<Middleware> => roomEventMocks.ctx.middleware
}));

vi.mock(import('@shared-web/browser/state-read/state-event-http-api.ts'), (): Partial<StateEventHttpApiModule> => ({
    listStateClientEventPage: vi.fn(),
    listStateClientEvents: vi.fn(),
    listStateGroupEventPage: roomEventMocks.listStateGroupEventPage,
    listStateGroupEvents: roomEventMocks.listStateGroupEvents
}));

vi.mock(import('@shared-web/browser/state-read/refresh-state-snapshots.ts'), () => ({
    refreshStateSnapshots: vi.fn(async () => ({ clients: [], groups: [] }))
}));

vi.mock(import('@shared-web/browser/data-caches.ts'), () => ({
    hydrateStateCaches: roomEventMocks.hydrateStateCaches,
    onStateCacheChange: vi.fn(() => vi.fn())
}));

vi.mock(import('@shared/api/auth.ts'), () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: vi.fn(() => roomEventMocks.session),
    writeSession: vi.fn()
}));

vi.mock(import('@shared/repository/client-state-snapshots-repository.ts'), () => ({
    findClientStateSnapshotByPrincipalId: vi.fn(),
    getAllClientStateSnapshots: vi.fn(() => [])
}));

vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: roomEventMocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotByRef: roomEventMocks.findGroupStateSnapshotByRef,
    getAllGroupStateSnapshots: roomEventMocks.getAllGroupStateSnapshots
}));

export function readRoomEventMocks(): typeof roomEventMocks {
    return roomEventMocks;
}

export function resetRoomEventTestRuntime(): void {
    vi.clearAllMocks();
    roomEventMocks.hydrateStateCaches.mockResolvedValue(undefined);
    roomEventMocks.initMiddleware.mockResolvedValue(roomEventMocks.ctx);
    roomEventMocks.isMiddlewareReady.mockReturnValue(false);
    roomEventMocks.listStateGroupEvents.mockRejectedValue(new Error('group events not mocked'));
    roomEventMocks.listStateGroupEventPage.mockRejectedValue(
        new Error('group event page not mocked')
    );
    const { webSocketQueueBox, webRtcConnectionService } = roomEventMocks.ctx.middleware;
    vi.mocked(webSocketQueueBox.close).mockImplementation((code, reason) => {
        webSocketQueueBox.socket.close(code, reason);
    });
    vi.mocked(webSocketQueueBox.onAnyInboxMessageDo).mockReturnValue(webSocketQueueBox);
    vi.mocked(webSocketQueueBox.removeAnyInboxMessageCallback).mockReturnValue(true);
    vi.mocked(webRtcConnectionService.onRtcPeerLifecycleDo).mockReturnValue(webRtcConnectionService);
}

export function findRoomWsCallback(
    latest = false
): { onMessage?: (message: unknown) => Promise<void>; } | undefined {
    const calls = vi
        .mocked(roomEventMocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo)
        .mock.calls.filter(([callbackId]) => callbackId === 'rallar:ws:any-message');
    const call = latest ? calls.at(-1) : calls[0];
    return call?.[1] as { onMessage?: (message: unknown) => Promise<void>; } | undefined;
}

export function toRoomEventEnvelopeMessage(
    event: GroupEvent,
    options: Readonly<{ omitGroup?: boolean; }> = {}
) {
    const snapshot = createGroupSnapshotFixture({
        applicationId: event.applicationId,
        workspaceId: event.workspaceId,
        groupId: event.groupId,
        sessionIds: ['session-1']
    });
    const envelope: GroupStateDeltaEnvelope = {
        event,
        predecessorCausalRevision: { groupRevision: 1, presenceRevision: 0 },
        resultingCausalRevision: event.causalRevision,
        members: [],
        removedMemberPrincipalIds: [],
        sessions: [],
        removedSessionIds: [],
        activeSessionIds: snapshot.activeSessions.map((session) => session.sessionId),
        group: snapshot.group,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        audienceSessionIds: []
    };
    const payload = options.omitGroup
        ? omitGroupFromEnvelope(envelope)
        : envelope;
    return newALBroadcastMessage(
        'server-1',
        newALEventRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
        'all',
        AppTopics.groupStateEvent,
        payload
    );
}

function omitGroupFromEnvelope(
    envelope: GroupStateDeltaEnvelope
): Omit<GroupStateDeltaEnvelope, 'group'> {
    const { group: _group, ...incompleteEnvelope } = envelope;
    return incompleteEnvelope;
}

export function createRoomEvent(
    input: RoomEventFixtureInput
): GroupEvent {
    const { groupId, eventId, eventType } = input;
    return {
        applicationId: input.applicationId ?? 'app-1',
        workspaceId: input.workspaceId ?? 'workspace-1',
        groupId,
        eventId,
        eventType,
        snapshotVersion: input.snapshotVersion ?? 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        occurredAtEpochMs: input.occurredAtEpochMs ?? 1,
        actor: { kind: 'session', principalId: 'alice', sessionId: 'session-1' },
        reason: null,
        traceId: null,
        requestId: `request-${eventId}`,
        payload: {}
    };
}

export function createRoomEventPage(
    events: readonly GroupEvent[],
    hasMore: boolean
): StateEventPage<GroupEvent> {
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
