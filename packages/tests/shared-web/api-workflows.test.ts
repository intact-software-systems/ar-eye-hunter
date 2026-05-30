import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
    listStateClientEventPage,
    listStateClientEvents,
    listStateGroupEventPage,
    listStateGroupEvents,
} from '@shared-web/browser/api-integration.ts';
import {
    createAndJoinStateGroup,
    joinStateGroup,
    leaveStateGroup,
    refreshStateHeartbeat,
    refreshStateSnapshots,
} from '@shared-web/browser/api-workflows.ts';

type FetchCall = Readonly<{
    url: string;
    method: string;
    body?: unknown;
    signal?: AbortSignal | null;
}>;

describe('state API workflows', () => {
    const fetchCalls: FetchCall[] = [];

    beforeEach(() => {
        fetchCalls.length = 0;
        configureApiClient({ apiBaseUrl: '' });
        vi.stubGlobal('localStorage', {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
        });
    });

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('refreshes client and group snapshots through an orchestrated API workflow', async () => {
        const clients = [clientSnapshot('principal-1')];
        const groups = [groupSnapshot('group-1')];
        stubFetch(({ url, method }) => {
            if (method === 'GET' && url.endsWith('/clients')) {
                return jsonResponse(clients);
            }

            if (method === 'GET' && url.endsWith('/groups')) {
                return jsonResponse(groups);
            }

            return notFoundResponse();
        });

        const result = await refreshStateSnapshots();

        expect(result).toEqual({ clients, groups });
        expect(fetchCalls.map((call) => call.url)).toEqual([
            '/api/state/apps/ar-eye-hunter/workspaces/default/clients',
            '/api/state/apps/ar-eye-hunter/workspaces/default/groups',
        ]);
    });

    it('uses configured API origin for state workflows', async () => {
        configureApiClient({ apiBaseUrl: 'https://api.example.test/' });
        const clients = [clientSnapshot('principal-1')];
        const groups = [groupSnapshot('group-1')];
        stubFetch(({ url, method }) => {
            if (method === 'GET' && url.endsWith('/clients')) {
                return jsonResponse(clients);
            }

            if (method === 'GET' && url.endsWith('/groups')) {
                return jsonResponse(groups);
            }

            return notFoundResponse();
        });

        await refreshStateSnapshots();

        expect(fetchCalls.map((call) => call.url)).toEqual([
            'https://api.example.test/api/state/apps/ar-eye-hunter/workspaces/default/clients',
            'https://api.example.test/api/state/apps/ar-eye-hunter/workspaces/default/groups',
        ]);
    });

    it('lists state events with entity encoding and query filters', async () => {
        const groupEvents = [groupEvent('group-event-1', 'member-joined')];
        const clientEvents = [clientEvent('client-event-1', 'session-connected')];
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1',
        };
        stubFetch(({ url, method }) => {
            if (method === 'GET' && url.includes('/groups/room%20%2F1/events')) {
                return jsonResponse(groupEvents);
            }

            if (
                method === 'GET' &&
                url.includes('/clients/alice%40example.test/events')
            ) {
                return jsonResponse(clientEvents);
            }

            return notFoundResponse();
        });

        await expect(
            listStateGroupEvents('room /1', scope, {
                eventTypes: ['member-joined', 'member-left'],
                limit: 10,
            }),
        ).resolves.toEqual(groupEvents);
        await expect(
            listStateClientEvents('alice@example.test', scope, {
                eventTypes: ['session-connected'],
                limit: 5,
            }),
        ).resolves.toEqual(clientEvents);

        expect(fetchCalls.map((call) => call.url)).toEqual([
            '/api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/events?eventType=member-joined&eventType=member-left&limit=10',
            '/api/state/apps/app%201/workspaces/workspace%2F1/clients/alice%40example.test/events?eventType=session-connected&limit=5',
        ]);
    });

    it('lists state event pages with cursor query filters', async () => {
        const groupEvents = [groupEvent('group-event-2', 'member-left')];
        const clientEvents = [clientEvent('client-event-2', 'session-disconnected')];
        const groupPage = {
            events: groupEvents,
            nextCursor: {
                snapshotVersion: 2,
                occurredAtEpochMs: 2_000,
                eventId: 'group-event-2',
            },
            hasMore: false,
        };
        const clientPage = {
            events: clientEvents,
            nextCursor: {
                snapshotVersion: 3,
                occurredAtEpochMs: 3_000,
                eventId: 'client-event-2',
            },
            hasMore: true,
        };
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1',
        };
        stubFetch(({ url, method }) => {
            if (method === 'GET' && url.includes('/groups/room%20%2F1/events/page')) {
                return jsonResponse(groupPage);
            }

            if (
                method === 'GET' &&
                url.includes('/clients/alice%40example.test/events/page')
            ) {
                return jsonResponse(clientPage);
            }

            return notFoundResponse();
        });

        await expect(
            listStateGroupEventPage('room /1', scope, {
                eventTypes: ['member-left'],
                limit: 10,
                after: {
                    snapshotVersion: 1,
                    occurredAtEpochMs: 1_000,
                    eventId: 'group-event-1',
                },
            }),
        ).resolves.toEqual(groupPage);
        await expect(
            listStateClientEventPage('alice@example.test', scope, {
                eventTypes: ['session-disconnected'],
                limit: 5,
                after: {
                    snapshotVersion: 2,
                    occurredAtEpochMs: 2_000,
                    eventId: 'client-event-1',
                },
            }),
        ).resolves.toEqual(clientPage);

        expect(fetchCalls.map((call) => call.url)).toEqual([
            '/api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/events/page?eventType=member-left&limit=10&afterSnapshotVersion=1&afterOccurredAtEpochMs=1000&afterEventId=group-event-1',
            '/api/state/apps/app%201/workspaces/workspace%2F1/clients/alice%40example.test/events/page?eventType=session-disconnected&limit=5&afterSnapshotVersion=2&afterOccurredAtEpochMs=2000&afterEventId=client-event-1',
        ]);
    });

    it('creates and joins a state group as a sequential workflow', async () => {
        vi.spyOn(crypto, 'randomUUID').mockReturnValue(
            'group-created' as ReturnType<typeof crypto.randomUUID>,
        );
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                const request = body as { groupId: string };
                return jsonResponse(groupSnapshot(request.groupId));
            }

            if (
                method === 'PUT' &&
                url.endsWith('/groups/group-created/sessions/session-1')
            ) {
                return jsonResponse(groupSnapshot('group-created'));
            }

            return notFoundResponse();
        });

        const result = await createAndJoinStateGroup(
            'My Room',
            'principal-1',
            'session-1',
        );

        expect(result.group.groupId).toBe('group-created');
        expect(fetchCalls.map((call) => call.method)).toEqual(['POST', 'PUT']);
        expect(fetchCalls[0].body).toMatchObject({
            groupId: 'group-created',
            slug: 'my-room',
            displayName: 'My Room',
            createdByPrincipalId: 'principal-1',
        });
    });

    it('creates and joins a state group with an explicit group id', async () => {
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                const request = body as { groupId: string };
                return jsonResponse(groupSnapshot(request.groupId));
            }

            if (
                method === 'PUT' &&
                url.endsWith('/groups/rallar/sessions/session-1')
            ) {
                return jsonResponse(groupSnapshot('rallar'));
            }

            return notFoundResponse();
        });

        const result = await createAndJoinStateGroup(
            'Rallar',
            'principal-1',
            'session-1',
            undefined,
            {},
            'rallar',
        );

        expect(result.group.groupId).toBe('rallar');
        expect(fetchCalls.map((call) => call.method)).toEqual(['POST', 'PUT']);
        expect(fetchCalls[0].body).toMatchObject({
            groupId: 'rallar',
            slug: 'rallar',
            displayName: 'Rallar',
            createdByPrincipalId: 'principal-1',
        });
    });

    it('reuses state group workflow request IDs across HTTP command retries', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('group-retry' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('create-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('presence-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request' as ReturnType<typeof crypto.randomUUID>);
        let createAttempts = 0;
        let presenceAttempts = 0;
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                createAttempts += 1;
                if (createAttempts === 1) {
                    return textResponse('transient create failure', 503);
                }

                return jsonResponse(groupSnapshot((body as { groupId: string }).groupId));
            }

            if (
                method === 'PUT' &&
                url.endsWith('/groups/group-retry/sessions/session-1')
            ) {
                presenceAttempts += 1;
                if (presenceAttempts === 1) {
                    return textResponse('transient presence failure', 503);
                }

                return jsonResponse(groupSnapshot('group-retry'));
            }

            return notFoundResponse();
        });

        await createAndJoinStateGroup(
            'Retry Room',
            'principal-1',
            'session-1',
            undefined,
            { command: { maxAttempts: 2 } },
        );

        const createRequestIds = fetchCalls
            .filter((call) => call.method === 'POST' && call.url.endsWith('/groups'))
            .map((call) => (call.body as { requestId?: string }).requestId);
        const presenceRequestIds = fetchCalls
            .filter((call) =>
                call.method === 'PUT' &&
                call.url.endsWith('/groups/group-retry/sessions/session-1')
            )
            .map((call) => (call.body as { requestId?: string }).requestId);

        expect(createRequestIds).toHaveLength(2);
        expect(new Set(createRequestIds).size).toBe(1);
        expect(createRequestIds[0]).toContain('create-request');
        expect(presenceRequestIds).toHaveLength(2);
        expect(new Set(presenceRequestIds).size).toBe(1);
        expect(presenceRequestIds[0]).toContain('presence-request');
        expect(createRequestIds[0]).not.toBe(presenceRequestIds[0]);
    });

    it('reuses join workflow request IDs across HTTP command retries', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('member-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('presence-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request' as ReturnType<typeof crypto.randomUUID>);
        let memberAttempts = 0;
        let presenceAttempts = 0;
        stubFetch(({ url, method }) => {
            if (
                method === 'PUT' &&
                url.endsWith('/groups/group-1/members/principal-1')
            ) {
                memberAttempts += 1;
                if (memberAttempts === 1) {
                    return textResponse('transient member failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            if (
                method === 'PUT' &&
                url.endsWith('/groups/group-1/sessions/session-1')
            ) {
                presenceAttempts += 1;
                if (presenceAttempts === 1) {
                    return textResponse('transient presence failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await joinStateGroup(
            'group-1',
            'principal-1',
            'session-1',
            undefined,
            { command: { maxAttempts: 2 } },
        );

        const memberRequestIds = fetchCalls
            .filter((call) =>
                call.method === 'PUT' &&
                call.url.endsWith('/groups/group-1/members/principal-1')
            )
            .map((call) => (call.body as { requestId?: string }).requestId);
        const presenceRequestIds = fetchCalls
            .filter((call) =>
                call.method === 'PUT' &&
                call.url.endsWith('/groups/group-1/sessions/session-1')
            )
            .map((call) => (call.body as { requestId?: string }).requestId);

        expect(memberRequestIds).toHaveLength(2);
        expect(new Set(memberRequestIds).size).toBe(1);
        expect(memberRequestIds[0]).toContain('member-request');
        expect(presenceRequestIds).toHaveLength(2);
        expect(new Set(presenceRequestIds).size).toBe(1);
        expect(presenceRequestIds[0]).toContain('presence-request');
        expect(memberRequestIds[0]).not.toBe(presenceRequestIds[0]);
    });

    it('continues leave workflow when disconnect presence has already gone away', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/disconnect')) {
                return textResponse('missing', 404);
            }

            if (
                method === 'PUT' &&
                url.endsWith('/groups/group-1/members/principal-1')
            ) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        const result = await leaveStateGroup(
            'group-1',
            'principal-1',
            'session-1',
        );

        expect(result.group.groupId).toBe('group-1');
        expect(fetchCalls.map((call) => call.method)).toEqual(['POST', 'PUT']);
        expect(fetchCalls[0].body).toMatchObject({
            requestId: expect.any(String),
        });
        expect(fetchCalls[1].body).toMatchObject({
            status: 'left',
            reason: 'left-group',
            requestId: expect.any(String),
        });
    });

    it('reuses leave workflow request IDs across HTTP command retries', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('disconnect-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('member-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request' as ReturnType<typeof crypto.randomUUID>);
        let disconnectAttempts = 0;
        let memberAttempts = 0;
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/disconnect')) {
                disconnectAttempts += 1;
                if (disconnectAttempts === 1) {
                    return textResponse('transient disconnect failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            if (
                method === 'PUT' &&
                url.endsWith('/groups/group-1/members/principal-1')
            ) {
                memberAttempts += 1;
                if (memberAttempts === 1) {
                    return textResponse('transient member failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await leaveStateGroup(
            'group-1',
            'principal-1',
            'session-1',
            undefined,
            { command: { maxAttempts: 2 } },
        );

        const disconnectRequestIds = fetchCalls
            .filter((call) => call.method === 'POST' && call.url.endsWith('/disconnect'))
            .map((call) => (call.body as { requestId?: string }).requestId);
        const memberRequestIds = fetchCalls
            .filter((call) =>
                call.method === 'PUT' &&
                call.url.endsWith('/groups/group-1/members/principal-1')
            )
            .map((call) => (call.body as { requestId?: string }).requestId);

        expect(disconnectRequestIds).toHaveLength(2);
        expect(new Set(disconnectRequestIds).size).toBe(1);
        expect(disconnectRequestIds[0]).toContain('disconnect-request');
        expect(memberRequestIds).toHaveLength(2);
        expect(new Set(memberRequestIds).size).toBe(1);
        expect(memberRequestIds[0]).toContain('member-request');
        expect(disconnectRequestIds[0]).not.toBe(memberRequestIds[0]);
    });

    it('orchestrates client and group heartbeats and tolerates missing group presence', async () => {
        const clientData: ClientInfo = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            isOnline: true,
        };
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/sessions/session-1/heartbeat')) {
                if (url.includes('/clients/principal-1/')) {
                    return jsonResponse(clientSnapshot('principal-1'));
                }

                if (url.includes('/groups/group-1/')) {
                    return jsonResponse(groupSnapshot('group-1'));
                }

                if (url.includes('/groups/group-2/')) {
                    return textResponse('missing', 404);
                }
            }

            return notFoundResponse();
        });

        const result = await refreshStateHeartbeat(clientData, [
            groupSnapshot('group-1'),
            groupSnapshot('group-2'),
        ]);

        expect(result.client.principal.principalId).toBe('principal-1');
        expect(result.groups.map((group) => group.group.groupId)).toEqual([
            'group-1',
        ]);
        expect(result.heartbeatAtEpochMs).toBe(1000);
        expect(result.expiresAtEpochMs).toBe(121000);
        expect(fetchCalls).toHaveLength(3);
    });

    it('reuses heartbeat workflow request IDs across HTTP command retries', async () => {
        const clientData: ClientInfo = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            isOnline: true,
        };
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('client-heartbeat-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('group-heartbeat-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request' as ReturnType<typeof crypto.randomUUID>);
        let clientAttempts = 0;
        let groupAttempts = 0;
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.endsWith('/sessions/session-1/heartbeat')
            ) {
                clientAttempts += 1;
                if (clientAttempts === 1) {
                    return textResponse('transient client heartbeat failure', 503);
                }

                return jsonResponse(clientSnapshot('principal-1'));
            }

            if (
                method === 'POST' &&
                url.includes('/groups/group-1/') &&
                url.endsWith('/sessions/session-1/heartbeat')
            ) {
                groupAttempts += 1;
                if (groupAttempts === 1) {
                    return textResponse('transient group heartbeat failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await refreshStateHeartbeat(clientData, [groupSnapshot('group-1')], {
            policies: { command: { maxAttempts: 2 } },
        });

        const clientRequestIds = fetchCalls
            .filter((call) =>
                call.method === 'POST' &&
                call.url.includes('/clients/principal-1/') &&
                call.url.endsWith('/sessions/session-1/heartbeat')
            )
            .map((call) => (call.body as { requestId?: string }).requestId);
        const groupRequestIds = fetchCalls
            .filter((call) =>
                call.method === 'POST' &&
                call.url.includes('/groups/group-1/') &&
                call.url.endsWith('/sessions/session-1/heartbeat')
            )
            .map((call) => (call.body as { requestId?: string }).requestId);

        expect(clientRequestIds).toHaveLength(2);
        expect(new Set(clientRequestIds).size).toBe(1);
        expect(clientRequestIds[0]).toContain('client-heartbeat-request');
        expect(groupRequestIds).toHaveLength(2);
        expect(new Set(groupRequestIds).size).toBe(1);
        expect(groupRequestIds[0]).toContain('group-heartbeat-request');
        expect(clientRequestIds[0]).not.toBe(groupRequestIds[0]);
    });

    it('passes command timeout aborts into endpoint fetch calls', async () => {
        vi.useFakeTimers();
        const signals: AbortSignal[] = [];
        stubFetch(({ signal }) => {
            if (signal) {
                signals.push(signal);
            }

            return new Promise<Response>(() => {
            });
        });

        const run = refreshStateSnapshots(undefined, {
            command: {
                timeoutMs: 10,
                shouldRetry: () => false,
            },
        });
        const expectation = expect(run).rejects.toThrow(
            'Command timed out after 10 ms',
        );

        await vi.advanceTimersByTimeAsync(10);

        await expectation;
        expect(signals).toHaveLength(2);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
    });

    it('exposes HTTP status on failed API requests for retry classification', async () => {
        stubFetch(() => textResponse('temporarily unavailable', 503));

        await expect(refreshStateSnapshots()).rejects.toMatchObject({
            status: 503,
            method: 'GET',
            bodyText: 'temporarily unavailable',
        });
    });

    function stubFetch(
        handler: (call: FetchCall) => Response | Promise<Response>,
    ): void {
        vi.stubGlobal(
            'fetch',
            vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
                const call: FetchCall = {
                    url: String(input),
                    method: init?.method ?? 'GET',
                    body: init?.body ? JSON.parse(String(init.body)) : undefined,
                    signal: init?.signal,
                };
                fetchCalls.push(call);
                return handler(call);
            }),
        );
    }
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function textResponse(body: string, status: number): Response {
    return new Response(body, { status });
}

function notFoundResponse(): Response {
    return textResponse('not found', 404);
}

function clientEvent(
    eventId: string,
    eventType: ClientEvent['eventType'],
): ClientEvent {
    return {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        principalId: 'principal-1',
        eventId,
        eventType,
        snapshotVersion: 1,
        occurredAtEpochMs: 1,
        actor: {
            serviceId: 'test',
        },
    };
}

function groupEvent(
    eventId: string,
    eventType: GroupEvent['eventType'],
): GroupEvent {
    return {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        groupId: 'group-1',
        eventId,
        eventType,
        snapshotVersion: 1,
        occurredAtEpochMs: 1,
        actor: {
            serviceId: 'test',
        },
    };
}

function clientSnapshot(principalId: string): ClientSnapshot {
    return {
        principal: {
            principalId,
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            username: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: 2,
            profileVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: 1 },
            updated: { atEpochMs: 1 },
        },
        instances: [],
        activeSessions: [],
        isOnline: true,
        activeSessionCount: 1,
    };
}

function groupSnapshot(groupId: string): GroupSnapshot {
    return {
        group: {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            groupId,
            slug: groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'invite-only',
            metadata: {},
            snapshotVersion: 3,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: 1 },
            updated: { atEpochMs: 1 },
        },
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0,
    };
}
