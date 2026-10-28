import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { readApiConfig, readIceCandidates } from '@shared-web/browser/connection/connection-http-api.ts';
import { crdtCatchUpHttpApi } from '@shared-web/browser/crdt/crdt-catch-up-http-api.ts';
import { appointStateGroupDirector } from '@shared-web/browser/director/appoint-room-director.ts';
import { roomGroupStateHttpApi } from '@shared-web/browser/rooms/room-group-state-http-api.ts';
import { rotateStateGroupJoinCode } from '@shared-web/browser/rooms/room-membership-group-state-workflows.ts';
import { readStateGroupTopology, readStateScopedGlobalGraph } from '@shared-web/browser/rtc/rtc-topology-http-api.ts';
import { connectStateClientSession } from '@shared-web/browser/session/client-session-http-api.ts';
import { refreshStateHeartbeat } from '@shared-web/browser/session/refresh-state-heartbeat.ts';
import { readStateClientSnapshot, readStateGroupSnapshot } from '@shared-web/browser/state-read/point-read.ts';
import { refreshStateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import { listStateGroupEventPage } from '@shared-web/browser/state-read/state-event-http-api.ts';
import { listStateGroups } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import { readStateGroupStats } from '@shared-web/browser/stats/rallar-stats-http-api.ts';
import { validateALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createClientSnapshotFixture, createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchObservation {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly body: object | undefined;
    readonly signal: AbortSignal | null;
}

interface RefreshAndHeartbeatResponseInput {
    readonly call: FetchObservation;
    readonly client: ReturnType<typeof clientSnapshot>;
    readonly group: ReturnType<typeof groupSnapshot>;
    readonly readClientAttempt: () => number;
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
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
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
        await expect(crdtCatchUpHttpApi.catchUpDocument(crdtCatchUpRequest())).resolves.toEqual({
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
        stubFetch((call) =>
            call.url.includes('/events/page')
                ? jsonResponse({
                    events: [event],
                    nextCursor: {
                        snapshotVersion: 1,
                        occurredAtEpochMs: 1,
                        eventId: 'event-1'
                    },
                    hasMore: false
                })
                : jsonResponse([snapshot])
        );

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

        await roomGroupStateHttpApi.createGroup({
            request: createGroupBody(),
            options: { requestId: 'create-request-000001' },
            scope
        });
        await roomGroupStateHttpApi.connectPresence({
            groupId: 'room-1',
            sessionId: 'session-1',
            request: connectGroupPresenceBody(),
            options: { requestId: 'presence-request-0001' },
            scope
        });
        await connectStateClientSession({
            principalId: 'owner-1',
            clientInstanceId: 'browser-1',
            sessionId: 'session-1',
            request: connectClientSessionBody(),
            options: { requestId: 'client-request-000001' },
            scope
        });
        await roomGroupStateHttpApi.appointDirector({
            groupId: 'room-1',
            request: { heartbeatTtlMs: 30_000, actorPrincipalId: 'owner-1', actorSessionId: 'session-1' },
            options: { requestId: 'director-request-0001' },
            scope
        });

        expect(observations.map(toMethodAndPath)).toEqual(expectedMutationPaths());
        expect(observations.every((call) => !hasRequestId(call.body))).toBe(true);
    });

    it('sends each request its own grammar-valid x-request-id', async () => {
        stubFetch((call) =>
            call.url.endsWith('/groups') ? jsonResponse([groupSnapshot()]) : call.url.endsWith('/api/config')
                ? connectionAndCrdtResponse(call.url)
                : mutationResponse(call.url)
        );

        await readApiConfig();
        await listStateGroups(scope, { authSession });
        await roomGroupStateHttpApi.createGroup({
            request: createGroupBody(),
            options: { requestId: 'create-request-000001' },
            scope
        });

        const traces = observations.map((call) => call.headers.get('x-request-id') ?? '');
        expect(traces.map((traceId) => validateALTraceId(traceId))).toEqual([[], [], []]);
        expect(new Set(traces).size).toBe(3);
    });

    it('sends the point reads with the api headers and their own x-request-id', async () => {
        stubFetch(() => new Response('not found', { status: 404 }));

        await expect(readStateClientSnapshot('owner-1', scope, { authSession })).rejects.toMatchObject({ status: 404 });
        await expect(readStateGroupSnapshot('room-1', scope, { authSession })).rejects.toMatchObject({ status: 404 });

        expect(observations.map(toMethodAndPath)).toEqual([
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/clients/owner-1',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room-1'
        ]);
        for (const call of observations) {
            expect(call.headers.get('authorization')).toBe('Bearer token-1');
            expect(call.headers.get('x-client-id')).toBe('owner-1');
            expect(validateALTraceId(call.headers.get('x-request-id') ?? '')).toEqual([]);
        }
        expect(observations[0]?.headers.get('x-request-id')).not.toBe(observations[1]?.headers.get('x-request-id'));
    });

    it('preserves snapshot refresh and heartbeat retry identity', async () => {
        const client = clientSnapshot();
        const group = groupSnapshot();
        let clientHeartbeatAttempts = 0;
        stubFetch((call) =>
            refreshAndHeartbeatResponse({
                call,
                client,
                group,
                readClientAttempt: () => {
                    clientHeartbeatAttempts += 1;
                    return clientHeartbeatAttempts;
                }
            })
        );

        await expect(refreshStateSnapshots(scope)).resolves.toEqual({
            clients: [client],
            groups: [group]
        });
        await refreshStateHeartbeat(
            { clientId: 'owner-1', sessionId: 'session-1', isOnline: true },
            [group],
            {
                generationId: 'generation-1',
                wsConnectionGenerationId: undefined,
                clientSnapshot: undefined,
                scope,
                policies: { command: { maxAttempts: 2 } }
            }
        );

        const heartbeatCalls = observations.filter((call) => call.url.includes('/heartbeat/requests/'));
        expect(heartbeatCalls).toHaveLength(3);
        const [clientRequestId, clientRetryRequestId, groupRequestId] = readRequestIds(heartbeatCalls);
        expect(clientRetryRequestId).toBe(clientRequestId);
        expect(groupRequestId).not.toBe(clientRequestId);
        expect(new Set(heartbeatCalls.map((call) => call.headers.get('x-request-id'))).size).toBe(3);
    });

    it('preserves director and join-code workflow actor translation', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('director-workflow-request' as `${string}-${string}-${string}-${string}-${string}`)
            .mockReturnValueOnce('join-code-workflow-request' as `${string}-${string}-${string}-${string}-${string}`);
        stubFetch((call) =>
            call.url.includes('/join-code/rotate')
                ? jsonResponse({ joinCode: 'join-1', expiresAtEpochMs: 20_000, snapshot: groupSnapshot() })
                : jsonResponse(groupSnapshot())
        );

        await appointStateGroupDirector({
            groupId: 'room-1',
            request: { heartbeatTtlMs: 30_000 },
            principalId: 'owner-1',
            sessionId: 'session-1',
            scope
        });
        await rotateStateGroupJoinCode({
            groupId: 'room-1',
            request: { joinCode: 'join-1', expiresAtEpochMs: 20_000 },
            actorPrincipalId: 'owner-1',
            sessionId: 'session-1',
            scope
        });

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

    it('reads a failed response\'s body the same way for a request and a point read, an unreadable body as empty', async () => {
        const bodies = ['temporarily unavailable', 'temporarily unavailable', undefined, undefined];
        stubFetch(() => toFailedResponse(bodies.shift()));

        const failed = { status: 503, bodyText: 'temporarily unavailable' };
        const unreadable = { status: 503, bodyText: '' };

        await expect(readApiConfig()).rejects.toMatchObject(failed);
        await expect(readStateGroupSnapshot('room-1', scope, { authSession })).rejects.toMatchObject(failed);
        await expect(readApiConfig()).rejects.toMatchObject(unreadable);
        await expect(readStateGroupSnapshot('room-1', scope, { authSession })).rejects.toMatchObject(unreadable);
    });
});

/** A 503 whose body reads as the given text, or whose body read fails when there is none. */
function toFailedResponse(body: string | undefined): Response {
    const response = new Response(body ?? null, { status: 503 });
    if (body === undefined) {
        vi.spyOn(response, 'text').mockRejectedValue(new TypeError('body stream already read'));
    }
    return response;
}

function stubFetch(response: (call: FetchObservation) => Response): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const call = observeFetch(url, init);
            observations.push(call);
            return response(call);
        })
    );
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
            endpoints: { createWs: '/api/ws' },
            serverPeerId: 'server'
        });
    }
    if (url.endsWith('/api/webrtc/ice')) {
        return jsonResponse({ iceServers: [], expiresAtEpochMs: 20_000 });
    }
    return jsonResponse({ ok: true, result: { marker: 'catch-up-result' } });
}

function refreshAndHeartbeatResponse(
    input: RefreshAndHeartbeatResponseInput
): Response {
    const { call, client, group, readClientAttempt } = input;
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
        kind: 'room' as const,
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
        connectionGenerationId: 'ws-generation-1',
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

function hasRequestId(body: object | undefined): boolean {
    return body !== undefined && 'requestId' in body;
}

function jsonResponse(body: object): Response {
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
