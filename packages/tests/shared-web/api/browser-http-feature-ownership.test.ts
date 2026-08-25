import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
    appointStateGroupDirector as appointStateGroupDirectorRequest,
    catchUpRallarCrdtDocument,
    connectStateClientSession,
    connectStateGroupPresenceSession,
    createStateGroup,
    listStateGroupEventPage,
    listStateGroups,
    readApiConfig,
    readIceCandidates,
    readStateGroupStats,
    readStateGroupTopology,
    readStateScopedGlobalGraph
} from '@shared-web/browser/api-integration.ts';
import {
    appointStateGroupDirector,
    refreshStateHeartbeat,
    refreshStateSnapshots,
    rotateStateGroupJoinCode
} from '@shared-web/browser/api-workflows.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createClientSnapshotFixture,
    createGroupSnapshotFixture
} from '../authoritative-group-fixtures.ts';

interface FetchObservation {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly body: unknown;
    readonly signal: AbortSignal | null;
}

const observations: FetchObservation[] = [];
const scope = { applicationId: 'app 1', workspaceId: 'workspace/1' } as const;
const authSession: AuthSession = {
    clientId: 'owner-1',
    accessToken: 'token-1',
    username: 'owner',
    sessionId: 'owner-session',
    expiresAtEpochMs: 60_000
};

describe('browser HTTP feature ownership characterization', () => {
    beforeEach(() => {
        observations.length = 0;
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
        vi.stubGlobal('localStorage', createLocalStorageDouble());
    });

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('preserves connection config, ICE, and CRDT catch-up requests', async () => {
        const controller = new AbortController();
        controller.abort();
        stubFetch((call) => connectionAndCrdtResponse(call.url));

        await expect(readApiConfig({ signal: controller.signal })).resolves.toMatchObject({
            apiBaseUrl: 'https://api.example.test'
        });
        await expect(readIceCandidates()).resolves.toEqual({
            iceServers: [],
            expiresAtEpochMs: 20_000
        });
        await expect(catchUpRallarCrdtDocument(crdtCatchUpRequest())).resolves.toEqual({
            marker: 'catch-up-result'
        });

        expect(observations.map(toMethodAndPath)).toEqual([
            'GET /api/config',
            'GET /api/webrtc/ice',
            'POST /api/crdt/catch-up'
        ]);
        expect(observations[0]?.signal).toBe(controller.signal);
        expect(observations[2]?.body).toEqual(crdtCatchUpRequest());
    });

    it('preserves state collection and validated event-page requests', async () => {
        const snapshot = groupSnapshot();
        const event = groupEvent();
        stubFetch((call) => call.url.includes('/events/page')
            ? jsonResponse({
                events: [event],
                nextCursor: {
                    snapshotVersion: 1,
                    occurredAtEpochMs: 1,
                    eventId: 'event-1'
                },
                hasMore: false
            })
            : jsonResponse([snapshot]));

        await expect(listStateGroups(scope, { authSession })).resolves.toEqual([snapshot]);
        await expect(listStateGroupEventPage('room /1', scope, {
            eventTypes: ['member-joined'],
            limit: 5
        })).resolves.toMatchObject({ events: [event] });

        expect(observations.map(toMethodAndPath)).toEqual([
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/events/page' +
                '?eventType=member-joined&limit=5'
        ]);
        expect(observations[0]?.headers.get('authorization')).toBe('Bearer token-1');
    });

    it('preserves graph, topology, and statistics read paths', async () => {
        stubFetch(() => jsonResponse({ ok: true }));

        await readStateScopedGlobalGraph(scope, { includeMeasured: true, refresh: 'always' });
        await readStateGroupTopology('room /1', scope);
        await readStateGroupStats('room /1', scope, { authSession });

        expect(observations.map(toMethodAndPath)).toEqual([
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/graphs/global' +
                '?includeMeasured=true&refresh=always',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/stats'
        ]);
        expect(observations[2]?.headers.get('x-client-id')).toBe('owner-1');
    });

    it('preserves group, presence, client-session, and director mutation requests', async () => {
        stubFetch((call) => mutationResponse(call.url));

        await createStateGroup(createGroupBody(), { requestId: 'create-request-000001' }, scope);
        await connectStateGroupPresenceSession(
            'room-1',
            'session-1',
            connectGroupPresenceBody(),
            { requestId: 'presence-request-0001' },
            scope
        );
        await connectStateClientSession(
            'owner-1',
            'browser-1',
            'session-1',
            connectClientSessionBody(),
            { requestId: 'client-request-000001' },
            scope
        );
        await appointStateGroupDirectorRequest(
            'room-1',
            { heartbeatTtlMs: 30_000, actorPrincipalId: 'owner-1', actorSessionId: 'session-1' },
            { requestId: 'director-request-0001' },
            scope
        );

        expect(observations.map(toMethodAndPath)).toEqual(expectedMutationPaths());
        expect(observations.every((call) => !hasRequestId(call.body))).toBe(true);
    });

    it('preserves snapshot refresh and heartbeat retry identity', async () => {
        const client = clientSnapshot();
        const group = groupSnapshot();
        let clientHeartbeatAttempts = 0;
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('client-heartbeat-request-id' as `${string}-${string}-${string}-${string}-${string}`)
            .mockReturnValueOnce('client-repair-request-id' as `${string}-${string}-${string}-${string}-${string}`)
            .mockReturnValueOnce('group-heartbeat-request-id' as `${string}-${string}-${string}-${string}-${string}`);
        stubFetch((call) => refreshAndHeartbeatResponse(call, client, group, () => {
            clientHeartbeatAttempts += 1;
            return clientHeartbeatAttempts;
        }));

        await expect(refreshStateSnapshots(scope)).resolves.toEqual({
            clients: [client],
            groups: [group]
        });
        await refreshStateHeartbeat(
            { clientId: 'owner-1', sessionId: 'session-1', isOnline: true },
            [group],
            { generationId: 'generation-1', scope, policies: { command: { maxAttempts: 2 } } }
        );

        const heartbeatCalls = observations.filter((call) => call.url.includes('/heartbeat/requests/'));
        expect(heartbeatCalls).toHaveLength(3);
        expect(readRequestIds(heartbeatCalls)).toEqual([
            'client-heartbeat-request-id',
            'client-heartbeat-request-id',
            'group-heartbeat-request-id'
        ]);
    });

    it('preserves director and join-code workflow actor translation', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('director-workflow-request' as `${string}-${string}-${string}-${string}-${string}`)
            .mockReturnValueOnce('join-code-workflow-request' as `${string}-${string}-${string}-${string}-${string}`);
        stubFetch((call) => call.url.includes('/join-code/rotate')
            ? jsonResponse({ joinCode: 'join-1', expiresAtEpochMs: 20_000, snapshot: groupSnapshot() })
            : jsonResponse(groupSnapshot()));

        await appointStateGroupDirector(
            'room-1',
            { heartbeatTtlMs: 30_000 },
            'owner-1',
            'session-1',
            scope
        );
        await rotateStateGroupJoinCode(
            'room-1',
            { joinCode: 'join-1', expiresAtEpochMs: 20_000 },
            'owner-1',
            'session-1',
            scope
        );

        expect(observations.map((call) => call.body)).toEqual([
            { heartbeatTtlMs: 30_000, actorPrincipalId: 'owner-1', actorSessionId: 'session-1' },
            {
                joinCode: 'join-1',
                expiresAtEpochMs: 20_000,
                actorPrincipalId: 'owner-1',
                actorSessionId: 'session-1'
            }
        ]);
    });

    it('preserves typed HTTP failures', async () => {
        stubFetch(() => new Response('temporarily unavailable', { status: 503 }));

        await expect(readApiConfig()).rejects.toMatchObject({
            method: 'GET',
            path: '/api/config',
            status: 503,
            bodyText: 'temporarily unavailable'
        });
    });
});

function stubFetch(response: (call: FetchObservation) => Response): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const call = observeFetch(url, init);
        observations.push(call);
        return response(call);
    }));
}

function observeFetch(url: string | URL | Request, init?: RequestInit): FetchObservation {
    const headers = new Headers(init?.headers);
    return {
        url: String(url),
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        signal: init?.signal ?? null
    };
}

function connectionAndCrdtResponse(url: string): Response {
    if (url.endsWith('/api/config')) {
        return jsonResponse({
            apiBaseUrl: 'https://api.example.test',
            wsBaseUrl: 'wss://api.example.test',
            endpoints: { createWs: '/api/ws' }
        });
    }
    if (url.endsWith('/api/webrtc/ice')) {
        return jsonResponse({ iceServers: [], expiresAtEpochMs: 20_000 });
    }
    return jsonResponse({ ok: true, result: { marker: 'catch-up-result' } });
}

function refreshAndHeartbeatResponse(
    call: FetchObservation,
    client: ReturnType<typeof clientSnapshot>,
    group: ReturnType<typeof groupSnapshot>,
    readClientAttempt: () => number
): Response {
    if (call.url.endsWith('/clients')) {
        return jsonResponse([client]);
    }
    if (call.url.endsWith('/groups')) {
        return jsonResponse([group]);
    }
    if (call.url.includes('/clients/') && call.url.includes('/heartbeat/requests/')) {
        return readClientAttempt() === 1
            ? new Response('retry', { status: 503 })
            : jsonResponse(client);
    }
    return jsonResponse(group);
}

function mutationResponse(url: string): Response {
    return url.includes('/clients/')
        ? jsonResponse(clientSnapshot())
        : jsonResponse(groupSnapshot());
}

function toMethodAndPath(call: FetchObservation): string {
    const url = new URL(call.url);
    return `${call.method} ${url.pathname}${url.search}`;
}

function readRequestIds(calls: readonly FetchObservation[]): string[] {
    return calls.map((call) => call.url.split('/requests/')[1] ?? '');
}

function expectedMutationPaths(): string[] {
    const base = '/api/state/apps/app%201/workspaces/workspace%2F1';
    return [
        `POST ${base}/groups/requests/create-request-000001`,
        `PUT ${base}/groups/room-1/sessions/session-1/requests/presence-request-0001`,
        `PUT ${base}/clients/owner-1/instances/browser-1/sessions/session-1/requests/client-request-000001`,
        `POST ${base}/groups/room-1/director/appoint/requests/director-request-0001`
    ];
}

function createGroupBody() {
    return {
        groupId: 'room-1',
        slug: 'room-1',
        displayName: 'Room 1',
        createdByPrincipalId: 'owner-1',
        metadata: {}
    };
}

function connectGroupPresenceBody() {
    return {
        generationId: 'generation-1',
        principalId: 'owner-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'session-1',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_000
    };
}

function connectClientSessionBody() {
    return {
        generationId: 'generation-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'session-1',
        presenceState: 'online' as const,
        transport: 'ws' as const,
        connectionId: 'connection-1',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_000
    };
}

function crdtCatchUpRequest() {
    return {
        protocolVersion: 1 as const,
        requestId: 'catch-up-1',
        document: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            scope: 'custom' as const,
            documentType: 'test',
            documentId: 'document-1',
            customScope: 'test'
        },
        replicaId: 'replica-1',
        createdAtEpochMs: 1,
        includeSnapshot: true
    };
}

function groupSnapshot() {
    return createGroupSnapshotFixture({
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        groupId: 'room-1',
        sessionIds: ['owner-1']
    });
}

function clientSnapshot() {
    return createClientSnapshotFixture({
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        principalId: 'owner-1'
    });
}

function groupEvent(): GroupEvent {
    return {
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        groupId: 'room /1',
        eventId: 'event-1',
        eventType: 'member-joined',
        snapshotVersion: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        occurredAtEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

function hasRequestId(body: unknown): boolean {
    return typeof body === 'object' && body !== null && 'requestId' in body;
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function createLocalStorageDouble(): Storage {
    return {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(() => null),
        length: 0
    };
}
