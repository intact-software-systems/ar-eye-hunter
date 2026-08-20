import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ClientInfo } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    createActiveGroupPresenceSessionFixture,
    createClientSnapshotFixture,
    createGroupSnapshotFixture,
} from './authoritative-group-fixtures.ts';
import type {
    GroupTopologyConfigAcceptedCausalRevision,
    PutGroupTopologyConfigRequest,
    PutGroupTopologyOverrideRequest,
    ReconfigureGroupTopologyRequest,
} from '@shared/api/graph-topology-management-types.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
    consumeAgentSessionTicketAt,
    issueAgentSessionTicketsAt,
} from '@shared-web/browser/auth/agent-session-ticket-http-api.ts';
import {
    deleteStateGroupTopologyConfig,
    deleteStateGroupTopologyOverride,
    listStateClientEventPage,
    listStateClientEvents,
    listStateGroupEventPage,
    listStateGroupEvents,
    putStateGroupTopologyConfig,
    putStateGroupTopologyOverride,
    readStateGroupGraph,
    readStateGroupStats,
    readStateGroupTopology,
    readStateGroupTopologyConfig,
    readStateGroupTopologyOverride,
    readStateMyRealtimeStatus,
    readStateScopedGlobalGraph,
    readStateWorkspaceStatsSummary,
    reconfigureStateGroupTopology,
} from '@shared-web/browser/api-integration.ts';
import {
    acceptStateGroupInvite,
    archiveStateGroup,
    banStateGroupMember,
    createAndJoinStateGroup,
    createStateGroupInvite,
    deleteStateGroup,
    joinStateGroup,
    leaveStateGroup,
    refreshStateHeartbeat,
    refreshStateSnapshots,
    removeStateGroupMember,
    revokeStateGroupInvite,
    rotateStateGroupJoinCode,
    setStateGroupMemberRole,
    transferStateGroupOwnership,
    unbanStateGroupMember,
    updateStateGroupDetails,
    updateStateGroupMetadata,
} from '@shared-web/browser/api-workflows.ts';

type FetchCall = Readonly<{
    url: string;
    method: string;
    headers: Record<string, string>;
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

    it('issues and consumes agent tickets against an explicit API base without changing the configured base', async () => {
        const authSession = {
            clientId: 'operator-client',
            accessToken: 'operator-token',
            username: 'alice',
            sessionId: 'operator-session',
            expiresAtEpochMs: 10_000,
        };
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.includes('/api/auth/agent-session-tickets/requests/')) {
                return jsonResponse({
                    tickets: [
                        {
                            agentId: 'agent-1',
                            ticket: 'ticket-1',
                            sessionId: 'agent-session-1',
                            expiresAtEpochMs: 9_000,
                        },
                    ],
                });
            }
            if (
                method === 'POST' &&
                url.includes('/api/auth/agent-session-tickets/consume/requests/')
            ) {
                return jsonResponse(authSession);
            }
            if (method === 'GET' && url.endsWith('/stats/me/realtime')) {
                return jsonResponse({});
            }
            return notFoundResponse();
        });

        await issueAgentSessionTicketsAt(
            'https://agent-api.example.test',
            { agentIds: ['agent-1'] },
            { authSession },
        );
        await consumeAgentSessionTicketAt('https://agent-api.example.test', { ticket: 'ticket-1' });
        await readStateMyRealtimeStatus();

        expect(fetchCalls.map((call) => withoutMutationRequestPath(call.url))).toEqual([
            'https://agent-api.example.test/api/auth/agent-session-tickets',
            'https://agent-api.example.test/api/auth/agent-session-tickets/consume',
            '/api/state/apps/rallar-server/workspaces/default/stats/me/realtime',
        ]);
        expect(fetchCalls[0].headers.authorization).toBe('Bearer operator-token');
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
            '/api/state/apps/rallar-server/workspaces/default/clients',
            '/api/state/apps/rallar-server/workspaces/default/groups',
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
            'https://api.example.test/api/state/apps/rallar-server/workspaces/default/clients',
            'https://api.example.test/api/state/apps/rallar-server/workspaces/default/groups',
        ]);
    });

    it('lists state events with entity encoding and query filters', async () => {
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1',
        };
        const groupEvents = [
            groupEvent('group-event-1', 'member-joined', {
                ...scope,
                groupId: 'room /1',
            }),
        ];
        const clientEvents = [
            clientEvent('client-event-1', 'session-connected', {
                ...scope,
                principalId: 'alice@example.test',
            }),
        ];
        stubFetch(({ url, method }) => {
            if (method === 'GET' && url.includes('/groups/room%20%2F1/events')) {
                return jsonResponse(groupEvents);
            }

            if (method === 'GET' && url.includes('/clients/alice%40example.test/events')) {
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
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1',
        };
        const groupEvents = [
            groupEvent('group-event-2', 'member-left', {
                ...scope,
                groupId: 'room /1',
            }),
        ];
        const clientEvents = [
            clientEvent('client-event-2', 'session-disconnected', {
                ...scope,
                principalId: 'alice@example.test',
            }),
        ];
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
        stubFetch(({ url, method }) => {
            if (method === 'GET' && url.includes('/groups/room%20%2F1/events/page')) {
                return jsonResponse(groupPage);
            }

            if (method === 'GET' && url.includes('/clients/alice%40example.test/events/page')) {
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

    it('rejects malformed authoritative event lists and pages from REST', async () => {
        const scope = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        };
        stubFetch(({ url }) => {
            if (url.includes('/groups/room-1/events')) {
                return jsonResponse([
                    {
                        ...groupEvent('group-event-1', 'member-joined', {
                            ...scope,
                            groupId: 'room-1',
                        }),
                        actor: { kind: 'service', serviceId: '' },
                    },
                ]);
            }
            return jsonResponse({
                events: [
                    {
                        ...clientEvent('client-event-1', 'session-connected', {
                            ...scope,
                            principalId: 'alice',
                        }),
                        snapshotVersion: 1.5,
                    },
                ],
                nextCursor: {
                    snapshotVersion: 1,
                    occurredAtEpochMs: 1,
                    eventId: 'client-event-1',
                },
                hasMore: false,
            });
        });

        await expect(listStateGroupEvents('room-1', scope)).rejects.toThrow(/actor|serviceId/);
        await expect(listStateClientEventPage('alice', scope)).rejects.toThrow(/snapshotVersion/);
    });

    it('reads scoped graph diagnostics and topology views with encoded query paths', async () => {
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1',
        };
        stubFetch(() => jsonResponse({ ok: true }));

        await readStateScopedGlobalGraph(scope, {
            includeMeasured: true,
            refresh: 'always',
        });
        await readStateGroupGraph('room /1', scope, {
            includeMeasured: true,
            refresh: 'never',
        });
        await readStateGroupTopology('room /1', scope);
        await readStateGroupTopologyConfig('room /1', scope);
        await readStateGroupTopologyOverride('room /1', scope);

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/graphs/global?includeMeasured=true&refresh=always',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/graphs/latest?includeMeasured=true&refresh=never',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology/config',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology/override',
        ]);
    });

    it('reads SPA statistics with encoded state paths and auth forwarding', async () => {
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1',
        };
        const authSession = {
            clientId: 'alice',
            username: 'alice',
            sessionId: 'alice-session',
            accessToken: 'token-1',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        stubFetch(() => jsonResponse({ ok: true }));

        await readStateWorkspaceStatsSummary(scope, { authSession });
        await readStateGroupStats('room /1', scope, { authSession });
        await readStateMyRealtimeStatus(scope, { authSession });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/stats/summary',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/stats',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/stats/me/realtime',
        ]);
        expect(fetchCalls.every((call) => call.headers.authorization === 'Bearer token-1')).toBe(
            true,
        );
        expect(fetchCalls.every((call) => call.headers['x-client-id'] === 'alice')).toBe(true);
    });

    it('mutates topology config and overrides with auth-capable methods', async () => {
        expectTypeOf<PutGroupTopologyConfigRequest>().toMatchTypeOf<
            Readonly<{ requestId: string }>
        >();
        expectTypeOf<PutGroupTopologyOverrideRequest>().toMatchTypeOf<
            Readonly<{ requestId: string }>
        >();
        expectTypeOf<ReconfigureGroupTopologyRequest>().toMatchTypeOf<
            Readonly<{ requestId: string }>
        >();
        type ConfigReceipt = Awaited<ReturnType<typeof putStateGroupTopologyConfig>>['receipt'];
        expectTypeOf<
            ConfigReceipt['acceptedCausalRevision']
        >().toEqualTypeOf<GroupTopologyConfigAcceptedCausalRevision | null>();
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1',
        };
        const authSession = {
            clientId: 'owner-1',
            username: 'owner',
            sessionId: 'owner-session',
            accessToken: 'token-1',
            expiresAtEpochMs: Date.now() + 60_000,
        };
        stubFetch(() => jsonResponse({ ok: true }));

        await putStateGroupTopologyConfig(
            'room /1',
            {
                requestId: 'config-1',
                config: { topologyKind: 'mesh', degreeLimit: 3 },
            },
            scope,
            { authSession },
        );
        await putStateGroupTopologyOverride(
            'room /1',
            {
                requestId: 'override-1',
                config: { topologyKind: 'star' },
                ttlMs: 60_000,
            },
            scope,
            { authSession },
        );
        await reconfigureStateGroupTopology(
            'room /1',
            {
                requestId: 'reconfigure-1',
                options: { topologyKind: 'tree' },
                publish: false,
            },
            scope,
            { authSession },
        );
        await deleteStateGroupTopologyConfig('room /1', scope, {
            authSession,
            requestId: 'config-delete-1',
        });
        await deleteStateGroupTopologyOverride('room /1', scope, {
            authSession,
            requestId: 'override-delete-1',
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'PUT /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology/config',
            'PUT /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology/override',
            'POST /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology/reconfigure',
            'DELETE /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology/config',
            'DELETE /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology/override',
        ]);
        expect(fetchCalls.every((call) => call.headers.authorization === 'Bearer token-1')).toBe(
            true,
        );
        expect(fetchCalls.map((call) => call.headers['idempotency-key'])).toEqual([
            'config-1',
            'override-1',
            'reconfigure-1',
            'config-delete-1',
            'override-delete-1',
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            requestId: 'config-1',
            config: { topologyKind: 'mesh', degreeLimit: 3 },
        });
        expect(fetchCalls[1].body).toMatchObject({
            requestId: 'override-1',
            config: { topologyKind: 'star' },
            ttlMs: 60_000,
        });
        expect(fetchCalls[2].body).toMatchObject({
            requestId: 'reconfigure-1',
            options: { topologyKind: 'tree' },
            publish: false,
        });
        expect(fetchCalls[3].body).toBeUndefined();
        expect(fetchCalls[4].body).toBeUndefined();
        expect(fetchCalls[3].headers['idempotency-key']).toBe('config-delete-1');
        expect(fetchCalls[4].headers['idempotency-key']).toBe('override-delete-1');
    });

    it('rejects empty topology mutation request ids before issuing HTTP', async () => {
        const scope = { applicationId: 'app', workspaceId: 'workspace' };
        const cases = [
            () => putStateGroupTopologyConfig('room', { requestId: '', config: {} }, scope),
            () =>
                putStateGroupTopologyOverride(
                    'room',
                    { requestId: '', config: {}, ttlMs: 1 },
                    scope,
                ),
            () => reconfigureStateGroupTopology('room', { requestId: '' }, scope),
            () => deleteStateGroupTopologyConfig('room', scope, { requestId: '' }),
            () => deleteStateGroupTopologyOverride('room', scope, { requestId: '' }),
        ];

        for (const call of cases) {
            await expect(call()).rejects.toThrow('Topology mutation requestId must be non-empty');
        }
        expect(fetchCalls).toHaveLength(0);
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

            if (method === 'PUT' && url.endsWith('/groups/group-created/sessions/session-1')) {
                return jsonResponse(groupSnapshot('group-created'));
            }

            return notFoundResponse();
        });

        const result = await createAndJoinStateGroup(
            'My Room',
            'principal-1',
            'session-1',
            'generation-1',
        );

        expect(result.group.groupId).toBe('group-created');
        expect(fetchCalls.map((call) => call.method)).toEqual(['POST', 'PUT']);
        expect(fetchCalls[0].body).toMatchObject({
            groupId: 'group-created',
            slug: 'my-room',
            displayName: 'My Room',
            createdByPrincipalId: 'principal-1',
        });
        expect(fetchCalls[1].body).toMatchObject({
            generationId: 'generation-1',
        });
    });

    it('creates and joins a state group with an explicit group id', async () => {
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                const request = body as { groupId: string };
                return jsonResponse(groupSnapshot(request.groupId));
            }

            if (method === 'PUT' && url.endsWith('/groups/rallar/sessions/session-1')) {
                return jsonResponse(groupSnapshot('rallar'));
            }

            return notFoundResponse();
        });

        const result = await createAndJoinStateGroup(
            'Rallar',
            'principal-1',
            'session-1',
            'generation-1',
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

    it('passes optional safe create fields through create-and-join', async () => {
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                const request = body as { groupId: string };
                return jsonResponse(groupSnapshot(request.groupId));
            }

            if (method === 'PUT' && url.endsWith('/groups/rallar/sessions/session-1')) {
                return jsonResponse(groupSnapshot('rallar'));
            }

            return notFoundResponse();
        });

        await createAndJoinStateGroup(
            'Rallar',
            'principal-1',
            'session-1',
            'generation-1',
            undefined,
            {},
            'rallar',
            {
                description: 'Mission room',
                joinMode: 'open',
                maxMembers: 8,
                maxSessionsPerMember: 2,
                metadata: { map: 'fjord' },
            },
        );

        expect(fetchCalls[0].body).toMatchObject({
            description: 'Mission room',
            joinMode: 'open',
            maxMembers: 8,
            maxSessionsPerMember: 2,
            metadata: { map: 'fjord' },
        });
    });

    it('updates group metadata by reading and merging current metadata', async () => {
        const base = groupSnapshot('group-1');
        const existing = {
            ...base,
            group: {
                ...base.group,
                metadata: {
                    keep: true,
                    rallarDirector: { old: true },
                },
            },
        };
        const updated = {
            ...existing,
            group: {
                ...existing.group,
                metadata: {
                    keep: true,
                    rallarDirector: { next: true },
                },
            },
        };
        stubFetch(({ url, method }) => {
            if (method === 'GET' && url.endsWith('/groups/group-1')) {
                return groupPointResponse(existing);
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1')) {
                return jsonResponse(updated);
            }

            return notFoundResponse();
        });

        const result = await updateStateGroupMetadata(
            'group-1',
            { rallarDirector: { next: true } },
            'principal-1',
            'session-1',
        );

        expect(result).toEqual(updated);
        expect(fetchCalls.map((call) => call.method)).toEqual(['GET', 'PUT']);
        expect(fetchCalls[1].body).toMatchObject({
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1',
            metadata: {
                keep: true,
                rallarDirector: { next: true },
            },
        });
    });

    it('updates archives and deletes state groups through low-level workflows', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'PUT' && url.endsWith('/groups/group-1')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await updateStateGroupDetails(
            'group-1',
            {
                displayName: 'Renamed',
                description: 'Mission room',
                joinMode: 'open',
                maxMembers: 8,
                maxSessionsPerMember: 2,
                metadata: { map: 'fjord' },
            },
            'owner-1',
            'owner-session',
        );
        await archiveStateGroup('group-1', {}, 'owner-1', 'owner-session');
        await deleteStateGroup('group-1', {}, 'owner-1', 'owner-session');

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1',
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            displayName: 'Renamed',
            description: 'Mission room',
            joinMode: 'open',
            maxMembers: 8,
            maxSessionsPerMember: 2,
            metadata: { map: 'fjord' },
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
        });
        expect(fetchCalls[1].body).toMatchObject({
            status: 'archived',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
        });
        expect(fetchCalls[2].body).toMatchObject({
            status: 'deleted',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
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

            if (method === 'PUT' && url.endsWith('/groups/group-retry/sessions/session-1')) {
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
            'generation-1',
            undefined,
            { command: { maxAttempts: 2 } },
        );

        const createRequestIds = fetchCalls
            .filter((call) => call.method === 'POST' && call.url.endsWith('/groups'))
            .map((call) => (call.body as { requestId?: string }).requestId);
        const presenceRequestIds = fetchCalls
            .filter(
                (call) =>
                    call.method === 'PUT' &&
                    call.url.endsWith('/groups/group-retry/sessions/session-1'),
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

    it('joins a state group with explicit join intent before connecting presence', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await expect(
            joinStateGroup(
                'group-1',
                'principal-1',
                'session-1',
                'generation-1',
                undefined,
                {},
                {
                    inviteToken: 'invite-1',
                    joinCode: 'code-1',
                },
            ),
        ).resolves.toMatchObject({
            group: { groupId: 'group-1' },
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/join',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/session-1',
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            inviteToken: 'invite-1',
            joinCode: 'code-1',
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1',
        });
        expect(fetchCalls[1].body).toMatchObject({
            generationId: 'generation-1',
        });
    });

    it('surfaces full-room policy codes from join workflows without connecting presence', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                return jsonResponse(
                    {
                        error: 'Forbidden: Group member capacity has been reached.',
                        code: 'group-full',
                        message: 'Group member capacity has been reached.',
                    },
                    403,
                );
            }

            return notFoundResponse();
        });

        await expect(
            joinStateGroup('group-1', 'principal-1', 'session-1', 'generation-1'),
        ).rejects.toMatchObject({
            status: 403,
            policyError: {
                code: 'group-full',
                message: 'Group member capacity has been reached.',
            },
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/join',
        ]);
    });

    it('surfaces session-limit policy codes from join presence workflows', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                return jsonResponse(
                    {
                        error: 'Forbidden: Group member session capacity has been reached.',
                        code: 'member-session-limit-reached',
                        message: 'Group member session capacity has been reached.',
                    },
                    403,
                );
            }

            return notFoundResponse();
        });

        await expect(
            joinStateGroup('group-1', 'principal-1', 'session-1', 'generation-1'),
        ).rejects.toMatchObject({
            status: 403,
            policyError: {
                code: 'member-session-limit-reached',
                message: 'Group member session capacity has been reached.',
            },
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/join',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/session-1',
        ]);
    });

    it('creates and revokes state group invites through low-level workflows', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/invites/member-1')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'POST' && url.endsWith('/groups/group-1/invites/member-1/revoke')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await createStateGroupInvite(
            'group-1',
            'member-1',
            { invitationExpiresAtEpochMs: 2_000 },
            'owner-1',
            'owner-session',
        );
        await revokeStateGroupInvite('group-1', 'member-1', {}, 'owner-1', 'owner-session');

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/member-1',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/member-1/revoke',
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            invitationExpiresAtEpochMs: 2_000,
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
        });
        expect(fetchCalls[1].body).toMatchObject({
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
        });
    });

    it('accepts a state group invite before connecting presence', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/invites/accept')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/member-session')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await expect(
            acceptStateGroupInvite('group-1', 'member-1', 'member-session', 'generation-1'),
        ).resolves.toMatchObject({
            group: { groupId: 'group-1' },
        });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/accept',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/member-session',
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            actorPrincipalId: 'member-1',
            actorSessionId: 'member-session',
        });
        expect(fetchCalls[1].body).toMatchObject({
            principalId: 'member-1',
            generationId: 'generation-1',
            actorPrincipalId: 'member-1',
            actorSessionId: 'member-session',
        });
    });

    it('rotates a state group join code through a low-level workflow', async () => {
        const response = {
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            snapshot: groupSnapshot('group-1'),
        };
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join-code/rotate')) {
                return jsonResponse(response);
            }

            return notFoundResponse();
        });

        await expect(
            rotateStateGroupJoinCode(
                'group-1',
                {
                    joinCode: 'code-1',
                    expiresAtEpochMs: 2_000,
                },
                'owner-1',
                'owner-session',
            ),
        ).resolves.toEqual(response);

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/join-code/rotate',
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
        });
    });

    it('runs membership governance through low-level workflows', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/members/member-1/remove')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'POST' && url.endsWith('/groups/group-1/members/member-1/ban')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'POST' && url.endsWith('/groups/group-1/members/member-1/unban')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/members/member-1/role')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'POST' && url.endsWith('/groups/group-1/owner/transfer')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await removeStateGroupMember('group-1', 'member-1', {}, 'owner-1', 'owner-session');
        await banStateGroupMember('group-1', 'member-1', {}, 'owner-1', 'owner-session');
        await unbanStateGroupMember('group-1', 'member-1', {}, 'owner-1', 'owner-session');
        await setStateGroupMemberRole(
            'group-1',
            'member-1',
            { role: 'admin' },
            'owner-1',
            'owner-session',
        );
        await transferStateGroupOwnership(
            'group-1',
            { newOwnerPrincipalId: 'member-1' },
            'owner-1',
            'owner-session',
        );

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/remove',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/ban',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/unban',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/role',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/owner/transfer',
        ]);
        for (const call of fetchCalls) {
            expect(call.body).toMatchObject({
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
            });
        }
        expect(fetchCalls[3].body).toMatchObject({ role: 'admin' });
        expect(fetchCalls[4].body).toMatchObject({
            newOwnerPrincipalId: 'member-1',
        });
    });

    it('reuses join workflow request IDs across HTTP command retries', async () => {
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('join-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('presence-request' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request' as ReturnType<typeof crypto.randomUUID>);
        let joinAttempts = 0;
        let presenceAttempts = 0;
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                joinAttempts += 1;
                if (joinAttempts === 1) {
                    return textResponse('transient join failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                presenceAttempts += 1;
                if (presenceAttempts === 1) {
                    return textResponse('transient presence failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await joinStateGroup('group-1', 'principal-1', 'session-1', 'generation-1', undefined, {
            command: { maxAttempts: 2 },
        });

        const joinRequestIds = fetchCalls
            .filter((call) => call.method === 'POST' && call.url.endsWith('/groups/group-1/join'))
            .map((call) => (call.body as { requestId?: string }).requestId);
        const presenceRequestIds = fetchCalls
            .filter(
                (call) =>
                    call.method === 'PUT' &&
                    call.url.endsWith('/groups/group-1/sessions/session-1'),
            )
            .map((call) => (call.body as { requestId?: string }).requestId);

        expect(joinRequestIds).toHaveLength(2);
        expect(new Set(joinRequestIds).size).toBe(1);
        expect(joinRequestIds[0]).toContain('join-request');
        expect(presenceRequestIds).toHaveLength(2);
        expect(new Set(presenceRequestIds).size).toBe(1);
        expect(presenceRequestIds[0]).toContain('presence-request');
        expect(joinRequestIds[0]).not.toBe(presenceRequestIds[0]);
    });

    it('continues leave workflow when disconnect presence has already gone away', async () => {
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/disconnect')) {
                return textResponse('missing', 404);
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/members/principal-1')) {
                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        const result = await leaveStateGroup('group-1', 'principal-1', 'session-1', 'generation-1');

        expect(result.group.groupId).toBe('group-1');
        expect(fetchCalls.map((call) => call.method)).toEqual(['POST', 'PUT']);
        expect(fetchCalls[0].body).toMatchObject({
            generationId: 'generation-1',
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

            if (method === 'PUT' && url.endsWith('/groups/group-1/members/principal-1')) {
                memberAttempts += 1;
                if (memberAttempts === 1) {
                    return textResponse('transient member failure', 503);
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await leaveStateGroup('group-1', 'principal-1', 'session-1', 'generation-1', undefined, {
            command: { maxAttempts: 2 },
        });

        const disconnectRequestIds = fetchCalls
            .filter((call) => call.method === 'POST' && call.url.endsWith('/disconnect'))
            .map((call) => (call.body as { requestId?: string }).requestId);
        const memberRequestIds = fetchCalls
            .filter(
                (call) =>
                    call.method === 'PUT' &&
                    call.url.endsWith('/groups/group-1/members/principal-1'),
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

    it('orchestrates client and group heartbeats and tolerates missing group presence without retrying 404s', async () => {
        const clientData: ClientInfo = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            isOnline: true,
        };
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.includes('/sessions/session-1/heartbeat')) {
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

        const result = await refreshStateHeartbeat(
            clientData,
            [
                groupSnapshotWithActiveSession('group-1', 'accepted-group-generation'),
                groupSnapshot('group-2'),
            ],
            {
                generationId: 'generation-1',
                policies: { command: { maxAttempts: 3 } },
            },
        );

        expect(result.client.principal.principalId).toBe('principal-1');
        expect(result.groups.map((group) => group.group.groupId)).toEqual(['group-1']);
        expect(result.missingGroups.map((group) => group.group.groupId)).toEqual(['group-2']);
        expect(result.heartbeatAtEpochMs).toBe(1000);
        expect(result.expiresAtEpochMs).toBe(121000);
        expect(fetchCalls.filter((call) => call.url.includes('/groups/group-2/'))).toHaveLength(1);
        expect(fetchCalls.find((call) => call.url.includes('/groups/group-1/'))?.body)
            .toMatchObject({
                generationId: 'accepted-group-generation',
            });
    });

    it('repairs missing client presence once after a scoped heartbeat 404', async () => {
        const clientData: ClientInfo = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            isOnline: true,
        };
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.startsWith(
                    '/api/state/apps/ar-eye-hunter/workspaces/default/clients/principal-1/instances/principal-1/sessions/session-1/heartbeat/requests/',
                )
            ) {
                return textResponse('Client principal not found: principal-1', 404);
            }

            if (
                method === 'PUT' &&
                url.startsWith(
                    '/api/state/apps/ar-eye-hunter/workspaces/default/clients/principal-1/instances/principal-1/sessions/session-1/requests/',
                )
            ) {
                return jsonResponse(clientSnapshot('principal-1', 'ar-eye-hunter'));
            }

            if (
                method === 'POST' &&
                url ===
                    '/api/state/apps/ar-eye-hunter/workspaces/default/groups/group-1/sessions/session-1/heartbeat'
            ) {
                return jsonResponse(groupSnapshot('group-1', 'ar-eye-hunter'));
            }

            return notFoundResponse();
        });

        const result = await refreshStateHeartbeat(
            clientData,
            [groupSnapshot('group-1', 'ar-eye-hunter')],
            {
                generationId: 'generation-1',
                scope: {
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default',
                },
                policies: { command: { maxAttempts: 3 } },
            },
        );

        expect(result.client.principal.principalId).toBe('principal-1');
        expect(result.groups.map((group) => group.group.groupId)).toEqual(['group-1']);
        expect(
            fetchCalls.map((call) => `${call.method} ${withoutMutationRequestPath(call.url)}`),
        ).toEqual([
            'POST /api/state/apps/ar-eye-hunter/workspaces/default/clients/principal-1/instances/principal-1/sessions/session-1/heartbeat',
            'PUT /api/state/apps/ar-eye-hunter/workspaces/default/clients/principal-1/instances/principal-1/sessions/session-1',
            'POST /api/state/apps/ar-eye-hunter/workspaces/default/groups/group-1/sessions/session-1/heartbeat',
        ]);
        expect(fetchCalls[1]?.body).toMatchObject({
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1',
            generationId: 'generation-1',
            presenceState: 'online',
            transport: 'ws',
            lastHeartbeatAtEpochMs: 1000,
            expiresAtEpochMs: 121000,
        });
    });

    it('surfaces member forbidden from create-and-join presence without raw membership repair', async () => {
        const connectUrls: string[] = [];
        const memberUrls: string[] = [];
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                return jsonResponse(groupSnapshot('group-1'), 201);
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/members/principal-1')) {
                memberUrls.push(url);
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                connectUrls.push(url);
                if (connectUrls.length === 1) {
                    return textResponse(
                        'Forbidden: group member not found for presence session: principal-1',
                        403,
                    );
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await expect(
            createAndJoinStateGroup(
                'Room 1',
                'principal-1',
                'session-1',
                'generation-1',
                undefined,
                undefined,
                'group-1',
            ),
        ).rejects.toThrow('403');

        expect(connectUrls).toHaveLength(1);
        expect(memberUrls).toHaveLength(0);
    });

    it('surfaces member forbidden from join presence without raw membership repair', async () => {
        const connectUrls: string[] = [];
        const joinBodies: unknown[] = [];
        stubFetch(({ url, method, body }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/join')) {
                joinBodies.push(body);
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                connectUrls.push(url);
                if (connectUrls.length === 1) {
                    return textResponse(
                        'Forbidden: group member is not active for presence session: principal-1',
                        403,
                    );
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await expect(
            joinStateGroup('group-1', 'principal-1', 'session-1', 'generation-1'),
        ).rejects.toThrow('403');

        expect(connectUrls).toHaveLength(1);
        expect(joinBodies).toHaveLength(1);
    });

    it('surfaces repeated member forbidden without presence repair attempts', async () => {
        const connectUrls: string[] = [];
        const memberUrls: string[] = [];
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups')) {
                return jsonResponse(groupSnapshot('group-1'), 201);
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/members/principal-1')) {
                memberUrls.push(url);
                return jsonResponse(groupSnapshot('group-1'));
            }

            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/session-1')) {
                connectUrls.push(url);
                return textResponse(
                    'Forbidden: group member not found for presence session: principal-1',
                    403,
                );
            }

            return notFoundResponse();
        });

        await expect(
            createAndJoinStateGroup(
                'Room 1',
                'principal-1',
                'session-1',
                'generation-1',
                undefined,
                undefined,
                'group-1',
            ),
        ).rejects.toThrow('403');

        expect(connectUrls).toHaveLength(1);
        expect(memberUrls).toHaveLength(0);
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
                url.includes('/sessions/session-1/heartbeat')
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
                url.includes('/sessions/session-1/heartbeat')
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
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } },
        });

        const clientRequestIds = fetchCalls
            .filter(
                (call) =>
                    call.method === 'POST' &&
                    call.url.includes('/clients/principal-1/') &&
                    call.url.includes('/sessions/session-1/heartbeat'),
            )
            .map((call) => call.url.match(/\/requests\/([A-Za-z0-9_-]+)$/u)?.[1]);
        const groupRequestIds = fetchCalls
            .filter(
                (call) =>
                    call.method === 'POST' &&
                    call.url.includes('/groups/group-1/') &&
                    call.url.includes('/sessions/session-1/heartbeat'),
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

    it('uses the provided auth session for heartbeat requests', async () => {
        const clientData: ClientInfo = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            isOnline: true,
        };
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.includes('/sessions/session-1/heartbeat')
            ) {
                return jsonResponse(clientSnapshot('principal-1'));
            }

            return notFoundResponse();
        });

        await refreshStateHeartbeat(clientData, [], {
            generationId: 'generation-1',
            authSession: {
                clientId: 'principal-1',
                username: 'alice',
                sessionId: 'session-1',
                accessToken: 'token-1',
                expiresAtEpochMs: Date.now() + 60_000,
            },
        });

        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].headers.authorization).toBe('Bearer token-1');
        expect(fetchCalls[0].headers['x-client-id']).toBe('principal-1');
    });

    it('passes command timeout aborts into endpoint fetch calls', async () => {
        vi.useFakeTimers();
        const signals: AbortSignal[] = [];
        stubFetch(({ signal }) => {
            if (signal) {
                signals.push(signal);
            }

            return new Promise<Response>(() => {});
        });

        const run = refreshStateSnapshots(undefined, {
            command: {
                timeoutMs: 10,
                shouldRetry: () => false,
            },
        });
        const expectation = expect(run).rejects.toThrow('Command timed out after 10 ms');

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

    it('preserves HTTP error details while exposing parsed policy error codes', async () => {
        const { readApiPolicyError } = await import('@shared-web/browser/api/http-error.ts');
        stubFetch(() =>
            jsonResponse(
                {
                    error: 'Forbidden: Invite required.',
                    code: 'group-invite-required',
                    message: 'Invite required.',
                    details: { groupId: 'room-1' },
                },
                403,
            )
        );

        await expect(refreshStateSnapshots()).rejects.toMatchObject({
            status: 403,
            method: 'GET',
            bodyText: JSON.stringify({
                error: 'Forbidden: Invite required.',
                code: 'group-invite-required',
                message: 'Invite required.',
                details: { groupId: 'room-1' },
            }),
            policyError: {
                error: 'Forbidden: Invite required.',
                code: 'group-invite-required',
                message: 'Invite required.',
                details: { groupId: 'room-1' },
            },
        });

        try {
            await refreshStateSnapshots();
        } catch (error) {
            expect(readApiPolicyError(error)).toMatchObject({
                code: 'group-invite-required',
                message: 'Invite required.',
            });
        }
    });

    function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
        vi.stubGlobal(
            'fetch',
            vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
                const call: FetchCall = {
                    url: String(input),
                    method: init?.method ?? 'GET',
                    headers: Object.fromEntries(new Headers(init?.headers).entries()),
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

function groupPointResponse(body: GroupSnapshot): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(body.causalRevision.groupRevision),
            'rallar-presence-revision': String(body.causalRevision.presenceRevision),
        },
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
    identity: Readonly<{
        applicationId?: string;
        workspaceId?: string;
        principalId?: string;
    }> = {},
): ClientEvent {
    return {
        applicationId: identity.applicationId ?? 'ar-eye-hunter',
        workspaceId: identity.workspaceId ?? 'default',
        principalId: identity.principalId ?? 'principal-1',
        eventId,
        eventType,
        snapshotVersion: 1,
        clientInstanceId: null,
        sessionId: null,
        occurredAtEpochMs: 1,
        actor: {
            kind: 'service',
            serviceId: 'test',
        },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
    };
}

function groupEvent(
    eventId: string,
    eventType: GroupEvent['eventType'],
    identity: Readonly<{
        applicationId?: string;
        workspaceId?: string;
        groupId?: string;
    }> = {},
): GroupEvent {
    return {
        applicationId: identity.applicationId ?? 'ar-eye-hunter',
        workspaceId: identity.workspaceId ?? 'default',
        groupId: identity.groupId ?? 'group-1',
        eventId,
        eventType,
        snapshotVersion: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        occurredAtEpochMs: 1,
        actor: {
            kind: 'service',
            serviceId: 'test',
        },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
    };
}

function clientSnapshot(principalId: string, applicationId = 'rallar-server'): ClientSnapshot {
    const snapshot = createClientSnapshotFixture({
        applicationId,
        workspaceId: 'default',
        principalId,
    });
    return {
        ...snapshot,
        principal: { ...snapshot.principal, snapshotVersion: 2 },
        isOnline: false,
        activeSessionCount: 0,
    };
}

function groupSnapshot(groupId: string, applicationId = 'rallar-server'): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId,
        workspaceId: 'default',
        groupId,
        sessionIds: [],
    });
    const groupRevision = 3;
    return {
        ...snapshot,
        stateRevision: groupRevision + snapshot.causalRevision.presenceRevision,
        causalRevision: {
            ...snapshot.causalRevision,
            groupRevision,
        },
        group: {
            ...snapshot.group,
            slug: groupId,
            joinMode: 'invite-only',
            snapshotVersion: groupRevision,
            metadataVersion: 1,
        },
    };
}

function groupSnapshotWithActiveSession(groupId: string, generationId: string): GroupSnapshot {
    const snapshot = groupSnapshot(groupId);
    return {
        ...snapshot,
        stateRevision: snapshot.stateRevision + 1,
        causalRevision: {
            ...snapshot.causalRevision,
            presenceRevision: snapshot.causalRevision.presenceRevision + 1,
        },
        group: {
            ...snapshot.group,
            presenceVersion: snapshot.group.presenceVersion + 1,
        },
        activeSessions: [
            {
                ...createActiveGroupPresenceSessionFixture({
                    applicationId: snapshot.group.applicationId,
                    workspaceId: snapshot.group.workspaceId,
                    groupId,
                    principalId: 'principal-1',
                    sessionId: 'session-1',
                }),
                generationId,
                expiresAtEpochMs: 121_000,
            },
        ],
        onlineMemberCount: 1,
    };
}

function withoutMutationRequestPath(url: string): string {
    return url.replace(/\/requests\/[A-Za-z0-9_-]+$/u, '');
}
