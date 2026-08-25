import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { consumeAgentSessionTicketAt, issueAgentSessionTicketsAt } from '@shared-web/browser/auth/agent-session-ticket-http-api.ts';
import { createAndJoinStateGroup, joinStateGroup } from '@shared-web/browser/rooms/room-group-state-workflows.ts';
import {
    readStateGroupGraph,
    readStateGroupTopology,
    readStateGroupTopologyConfig,
    readStateGroupTopologyOverride,
    readStateScopedGlobalGraph
} from '@shared-web/browser/rtc/rtc-topology-http-api.ts';
import { refreshStateHeartbeat } from '@shared-web/browser/session/refresh-state-heartbeat.ts';
import { refreshStateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import {
    listStateClientEventPage,
    listStateClientEvents,
    listStateGroupEventPage,
    listStateGroupEvents
} from '@shared-web/browser/state-read/state-event-http-api.ts';
import { readStateGroupStats, readStateMyRealtimeStatus, readStateWorkspaceStatsSummary } from '@shared-web/browser/stats/rallar-stats-http-api.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveGroupPresenceSessionFixture, createClientSnapshotFixture, createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

type FetchCall = Readonly<{
    url: string;
    physicalUrl: string;
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
            removeItem: vi.fn()
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
            expiresAtEpochMs: 10_000
        };
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.includes('/api/auth/agent-session-tickets/requests/')) {
                return jsonResponse({
                    tickets: [
                        {
                            agentId: 'agent-1',
                            ticket: 'ticket-1',
                            sessionId: 'agent-session-1',
                            expiresAtEpochMs: 9_000
                        }
                    ]
                });
            }
            if (method === 'POST' && url.includes('/api/auth/agent-session-tickets/consume/requests/')) {
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
            { requestId: 'agent-issue-request-id', authSession }
        );
        await consumeAgentSessionTicketAt(
            'https://agent-api.example.test',
            { ticket: 'ticket-1' },
            { requestId: 'agent-consume-request-id' }
        );
        await readStateMyRealtimeStatus();

        expect(fetchCalls.map((call) => withoutMutationRequestPath(call.url))).toEqual([
            'https://agent-api.example.test/api/auth/agent-session-tickets',
            'https://agent-api.example.test/api/auth/agent-session-tickets/consume',
            '/api/state/apps/rallar-server/workspaces/default/stats/me/realtime'
        ]);
        expect(fetchCalls[0].headers.authorization).toBe('Bearer operator-token');
    });

    it('reuses caller-owned request IDs when agent ticket responses are lost', async () => {
        let issueAttempts = 0;
        let consumeAttempts = 0;
        stubFetch(({ url }) => {
            if (url.includes('/agent-session-tickets/consume/requests/')) {
                consumeAttempts += 1;
                return consumeAttempts === 1
                    ? textResponse('response lost', 503)
                    : jsonResponse({
                        clientId: 'agent-1',
                        accessToken: 'agent-token',
                        username: 'operator',
                        sessionId: 'agent-session-1',
                        expiresAtEpochMs: 10_000
                    });
            }
            if (url.includes('/agent-session-tickets/requests/')) {
                issueAttempts += 1;
                return issueAttempts === 1
                    ? textResponse('response lost', 503)
                    : jsonResponse({ tickets: [] });
            }
            return notFoundResponse();
        });
        const issueOptions = {
            requestId: 'agent-issue-lost-response-id',
            authSession: null
        } as const;
        const consumeOptions = {
            requestId: 'agent-consume-lost-response-id',
            authSession: null
        } as const;

        await expect(
            issueAgentSessionTicketsAt(
                'https://agent-api.example.test',
                { agentIds: ['agent-1'] },
                issueOptions
            )
        ).rejects.toThrow('503');
        await issueAgentSessionTicketsAt(
            'https://agent-api.example.test',
            { agentIds: ['agent-1'] },
            issueOptions
        );
        await expect(
            consumeAgentSessionTicketAt(
                'https://agent-api.example.test',
                { ticket: 'ticket-1' },
                consumeOptions
            )
        ).rejects.toThrow('503');
        await consumeAgentSessionTicketAt(
            'https://agent-api.example.test',
            { ticket: 'ticket-1' },
            consumeOptions
        );

        const requestPaths = fetchCalls.map((call) => new URL(call.url).pathname);
        expect(requestPaths).toEqual([
            '/api/auth/agent-session-tickets/requests/agent-issue-lost-response-id',
            '/api/auth/agent-session-tickets/requests/agent-issue-lost-response-id',
            '/api/auth/agent-session-tickets/consume/requests/agent-consume-lost-response-id',
            '/api/auth/agent-session-tickets/consume/requests/agent-consume-lost-response-id'
        ]);
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
            '/api/state/apps/rallar-server/workspaces/default/groups'
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
            'https://api.example.test/api/state/apps/rallar-server/workspaces/default/groups'
        ]);
    });

    it('lists state events with entity encoding and query filters', async () => {
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1'
        };
        const groupEvents = [
            groupEvent('group-event-1', 'member-joined', {
                ...scope,
                groupId: 'room /1'
            })
        ];
        const clientEvents = [
            clientEvent('client-event-1', 'session-connected', {
                ...scope,
                principalId: 'alice@example.test'
            })
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
                limit: 10
            })
        ).resolves.toEqual(groupEvents);
        await expect(
            listStateClientEvents('alice@example.test', scope, {
                eventTypes: ['session-connected'],
                limit: 5
            })
        ).resolves.toEqual(clientEvents);

        expect(fetchCalls.map((call) => call.url)).toEqual([
            '/api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/events?eventType=member-joined&eventType=member-left&limit=10',
            '/api/state/apps/app%201/workspaces/workspace%2F1/clients/alice%40example.test/events?eventType=session-connected&limit=5'
        ]);
    });

    it('lists state event pages with cursor query filters', async () => {
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1'
        };
        const groupEvents = [
            groupEvent('group-event-2', 'member-left', {
                ...scope,
                groupId: 'room /1'
            })
        ];
        const clientEvents = [
            clientEvent('client-event-2', 'session-disconnected', {
                ...scope,
                principalId: 'alice@example.test'
            })
        ];
        const groupPage = {
            events: groupEvents,
            nextCursor: {
                snapshotVersion: 2,
                occurredAtEpochMs: 2_000,
                eventId: 'group-event-2'
            },
            hasMore: false
        };
        const clientPage = {
            events: clientEvents,
            nextCursor: {
                snapshotVersion: 3,
                occurredAtEpochMs: 3_000,
                eventId: 'client-event-2'
            },
            hasMore: true
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
                    eventId: 'group-event-1'
                }
            })
        ).resolves.toEqual(groupPage);
        await expect(
            listStateClientEventPage('alice@example.test', scope, {
                eventTypes: ['session-disconnected'],
                limit: 5,
                after: {
                    snapshotVersion: 2,
                    occurredAtEpochMs: 2_000,
                    eventId: 'client-event-1'
                }
            })
        ).resolves.toEqual(clientPage);

        expect(fetchCalls.map((call) => call.url)).toEqual([
            '/api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/events/page?eventType=member-left&limit=10&afterSnapshotVersion=1&afterOccurredAtEpochMs=1000&afterEventId=group-event-1',
            '/api/state/apps/app%201/workspaces/workspace%2F1/clients/alice%40example.test/events/page?eventType=session-disconnected&limit=5&afterSnapshotVersion=2&afterOccurredAtEpochMs=2000&afterEventId=client-event-1'
        ]);
    });

    it('rejects malformed authoritative event lists and pages from REST', async () => {
        const scope = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        };
        stubFetch(({ url }) => {
            if (url.includes('/groups/room-1/events')) {
                return jsonResponse([
                    {
                        ...groupEvent('group-event-1', 'member-joined', {
                            ...scope,
                            groupId: 'room-1'
                        }),
                        actor: { kind: 'service', serviceId: '' }
                    }
                ]);
            }
            return jsonResponse({
                events: [
                    {
                        ...clientEvent('client-event-1', 'session-connected', {
                            ...scope,
                            principalId: 'alice'
                        }),
                        snapshotVersion: 1.5
                    }
                ],
                nextCursor: {
                    snapshotVersion: 1,
                    occurredAtEpochMs: 1,
                    eventId: 'client-event-1'
                },
                hasMore: false
            });
        });

        await expect(listStateGroupEvents('room-1', scope)).rejects.toThrow(/actor|serviceId/);
        await expect(listStateClientEventPage('alice', scope)).rejects.toThrow(/snapshotVersion/);
    });

    it('reads scoped graph diagnostics and topology views with encoded query paths', async () => {
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1'
        };
        stubFetch(() => jsonResponse({ ok: true }));

        await readStateScopedGlobalGraph(scope, {
            includeMeasured: true,
            refresh: 'always'
        });
        await readStateGroupGraph('room /1', scope, {
            includeMeasured: true,
            refresh: 'never'
        });
        await readStateGroupTopology('room /1', scope);
        await readStateGroupTopologyConfig('room /1', scope);
        await readStateGroupTopologyOverride('room /1', scope);

        const scopePath = '/api/state/apps/app%201/workspaces/workspace%2F1';
        expect(fetchCalls.map((call) => `${call.method} ${call.physicalUrl}`)).toEqual([
            `GET ${scopePath}/graphs/global?includeMeasured=true&refresh=always`,
            `GET ${scopePath}/groups/room%20%2F1/graphs/latest?includeMeasured=true&refresh=never`,
            `GET ${scopePath}/groups/room%20%2F1/topology`,
            `GET ${scopePath}/groups/room%20%2F1/topology/config`,
            `GET ${scopePath}/groups/room%20%2F1/topology/override`
        ]);
    });

    it('reads SPA statistics with encoded state paths and auth forwarding', async () => {
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1'
        };
        const authSession = {
            clientId: 'alice',
            username: 'alice',
            sessionId: 'alice-session',
            accessToken: 'token-1',
            expiresAtEpochMs: Date.now() + 60_000
        };
        stubFetch(() => jsonResponse({ ok: true }));

        await readStateWorkspaceStatsSummary(scope, { authSession });
        await readStateGroupStats('room /1', scope, { authSession });
        await readStateMyRealtimeStatus(scope, { authSession });

        expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/stats/summary',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/stats',
            'GET /api/state/apps/app%201/workspaces/workspace%2F1/stats/me/realtime'
        ]);
        expect(fetchCalls.every((call) => call.headers.authorization === 'Bearer token-1')).toBe(true);
        expect(fetchCalls.every((call) => call.headers['x-client-id'] === 'alice')).toBe(true);
    });

    it(
        'orchestrates client and group heartbeats and tolerates missing group presence ' +
            'without retrying 404s',
        async () => {
            const clientData: ClientInfo = {
                clientId: 'principal-1',
                sessionId: 'session-1',
                isOnline: true
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
                    groupSnapshot('group-2')
                ],
                {
                    generationId: 'generation-1',
                    policies: { command: { maxAttempts: 3 } }
                }
            );

            expect(result.client.principal.principalId).toBe('principal-1');
            expect(result.groups.map((group) => group.group.groupId)).toEqual(['group-1']);
            expect(result.missingGroups.map((group) => group.group.groupId)).toEqual(['group-2']);
            expect(result.heartbeatAtEpochMs).toBe(1000);
            expect(result.expiresAtEpochMs).toBe(121000);
            expect(fetchCalls.filter((call) => call.url.includes('/groups/group-2/'))).toHaveLength(1);
            expect(fetchCalls.find((call) => call.url.includes('/groups/group-1/'))?.body).toMatchObject({
                generationId: 'accepted-group-generation'
            });
        }
    );

    it('repairs missing client presence once after a scoped heartbeat 404', async () => {
        const clientData: ClientInfo = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            isOnline: true
        };
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        const clientSessionPath = '/api/state/apps/ar-eye-hunter/workspaces/default/clients/principal-1' +
            '/instances/principal-1/sessions/session-1';
        const groupSessionPath = '/api/state/apps/ar-eye-hunter/workspaces/default/groups/group-1' +
            '/sessions/session-1';
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url === `${clientSessionPath}/heartbeat`
            ) {
                return textResponse('Client principal not found: principal-1', 404);
            }

            if (
                method === 'PUT' &&
                url === clientSessionPath
            ) {
                return jsonResponse(clientSnapshot('principal-1', 'ar-eye-hunter'));
            }

            if (
                method === 'POST' &&
                url === `${groupSessionPath}/heartbeat`
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
                    workspaceId: 'default'
                },
                policies: { command: { maxAttempts: 3 } }
            }
        );

        expect(result.client.principal.principalId).toBe('principal-1');
        expect(result.groups.map((group) => group.group.groupId)).toEqual(['group-1']);
        expect(
            fetchCalls.map((call) => `${call.method} ${withoutMutationRequestPath(call.url)}`)
        ).toEqual([
            `POST ${clientSessionPath}/heartbeat`,
            `PUT ${clientSessionPath}`,
            `POST ${groupSessionPath}/heartbeat`
        ]);
        expect(fetchCalls[1]?.body).toMatchObject({
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1',
            generationId: 'generation-1',
            presenceState: 'online',
            transport: 'ws',
            lastHeartbeatAtEpochMs: 1000,
            expiresAtEpochMs: 121000
        });
    });

    it(
        'surfaces member forbidden from create-and-join presence ' +
            'without raw membership repair',
        async () => {
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
                            403
                        );
                    }

                    return jsonResponse(groupSnapshot('group-1'));
                }

                return notFoundResponse();
            });

            await expect(
                createAndJoinStateGroup({
                    displayName: 'Room 1',
                    principalId: 'principal-1',
                    sessionId: 'session-1',
                    generationId: 'generation-1',
                    requestedGroupId: 'group-1'
                })
            ).rejects.toThrow('403');

            expect(connectUrls).toHaveLength(1);
            expect(memberUrls).toHaveLength(0);
        }
    );

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
                        403
                    );
                }

                return jsonResponse(groupSnapshot('group-1'));
            }

            return notFoundResponse();
        });

        await expect(
            joinStateGroup({
                groupId: 'group-1',
                principalId: 'principal-1',
                sessionId: 'session-1',
                generationId: 'generation-1'
            })
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
                    403
                );
            }

            return notFoundResponse();
        });

        await expect(
            createAndJoinStateGroup({
                displayName: 'Room 1',
                principalId: 'principal-1',
                sessionId: 'session-1',
                generationId: 'generation-1',
                requestedGroupId: 'group-1'
            })
        ).rejects.toThrow('403');

        expect(connectUrls).toHaveLength(1);
        expect(memberUrls).toHaveLength(0);
    });

    it('reuses heartbeat workflow request IDs across HTTP command retries', async () => {
        const clientData: ClientInfo = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            isOnline: true
        };
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('client-heartbeat-request-001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('client-repair-request-0001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('group-heartbeat-request-0001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request-0000001' as ReturnType<typeof crypto.randomUUID>);
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
            policies: { command: { maxAttempts: 2 } }
        });

        const clientRequestIds = fetchCalls
            .filter(
                (call) =>
                    call.method === 'POST' &&
                    call.url.includes('/clients/principal-1/') &&
                    call.url.includes('/sessions/session-1/heartbeat')
            )
            .map((call) => readMutationRequestId(call.physicalUrl));
        const groupRequestIds = fetchCalls
            .filter(
                (call) =>
                    call.method === 'POST' &&
                    call.url.includes('/groups/group-1/') &&
                    call.url.includes('/sessions/session-1/heartbeat')
            )
            .map((call) => readMutationRequestId(call.physicalUrl));

        expect(clientRequestIds).toHaveLength(2);
        expect(new Set(clientRequestIds).size).toBe(1);
        expect(clientRequestIds[0]).toBe('client-heartbeat-request-001');
        expect(groupRequestIds).toHaveLength(2);
        expect(new Set(groupRequestIds).size).toBe(1);
        expect(groupRequestIds[0]).toBe('group-heartbeat-request-0001');
        expect(clientRequestIds[0]).not.toBe(groupRequestIds[0]);
    });

    it('reuses a distinct presence repair request ID across heartbeat retries', async () => {
        const clientData: ClientInfo = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            isOnline: true
        };
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('client-heartbeat-request-id' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('client-repair-request-id' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unexpected-request-id' as ReturnType<typeof crypto.randomUUID>);
        let repairAttempts = 0;
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.includes('/sessions/session-1/heartbeat')
            ) {
                return textResponse('presence missing', 404);
            }
            if (
                method === 'PUT' &&
                url.includes('/clients/principal-1/') &&
                url.endsWith('/sessions/session-1')
            ) {
                repairAttempts += 1;
                return repairAttempts === 1
                    ? textResponse('repair response lost', 503)
                    : jsonResponse(clientSnapshot('principal-1'));
            }

            return notFoundResponse();
        });

        await refreshStateHeartbeat(clientData, [], {
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } }
        });

        const repairRequestIds = fetchCalls
            .filter(
                (call) => call.method === 'PUT' && call.physicalUrl.includes('/sessions/session-1/requests/')
            )
            .map((call) => readMutationRequestId(call.physicalUrl));
        expect(repairRequestIds).toEqual(['client-repair-request-id', 'client-repair-request-id']);
        expect(repairRequestIds[0]).not.toBe('client-heartbeat-request-id');
    });

    it('uses the provided auth session for heartbeat requests', async () => {
        const clientData: ClientInfo = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            isOnline: true
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
                expiresAtEpochMs: Date.now() + 60_000
            }
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
                shouldRetry: () => false
            }
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
            bodyText: 'temporarily unavailable'
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
                    details: { groupId: 'room-1' }
                },
                403
            )
        );

        await expect(refreshStateSnapshots()).rejects.toMatchObject({
            status: 403,
            method: 'GET',
            bodyText: JSON.stringify({
                error: 'Forbidden: Invite required.',
                code: 'group-invite-required',
                message: 'Invite required.',
                details: { groupId: 'room-1' }
            }),
            policyError: {
                error: 'Forbidden: Invite required.',
                code: 'group-invite-required',
                message: 'Invite required.',
                details: { groupId: 'room-1' }
            }
        });

        try {
            await refreshStateSnapshots();
        }
        catch (error) {
            expect(readApiPolicyError(error)).toMatchObject({
                code: 'group-invite-required',
                message: 'Invite required.'
            });
        }
    });

    function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
        vi.stubGlobal(
            'fetch',
            vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
                const physicalUrl = String(input);
                const call: FetchCall = {
                    url: physicalUrl.startsWith('/api/state/')
                        ? withoutMutationRequestPath(physicalUrl)
                        : physicalUrl,
                    physicalUrl,
                    method: init?.method ?? 'GET',
                    headers: Object.fromEntries(new Headers(init?.headers).entries()),
                    body: init?.body ? JSON.parse(String(init.body)) : undefined,
                    signal: init?.signal
                };
                fetchCalls.push(call);
                return handler(call);
            })
        );
    }
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
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
            'rallar-presence-revision': String(body.causalRevision.presenceRevision)
        }
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
    }> = {}
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
            serviceId: 'test'
        },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

function groupEvent(
    eventId: string,
    eventType: GroupEvent['eventType'],
    identity: Readonly<{
        applicationId?: string;
        workspaceId?: string;
        groupId?: string;
    }> = {}
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
            serviceId: 'test'
        },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

function clientSnapshot(principalId: string, applicationId = 'rallar-server'): ClientSnapshot {
    const snapshot = createClientSnapshotFixture({
        applicationId,
        workspaceId: 'default',
        principalId
    });
    return {
        ...snapshot,
        principal: { ...snapshot.principal, snapshotVersion: 2 },
        isOnline: false,
        activeSessionCount: 0
    };
}

function groupSnapshot(groupId: string, applicationId = 'rallar-server'): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId,
        workspaceId: 'default',
        groupId,
        sessionIds: []
    });
    const groupRevision = 3;
    return {
        ...snapshot,
        causalRevision: {
            ...snapshot.causalRevision,
            groupRevision
        },
        group: {
            ...snapshot.group,
            slug: groupId,
            joinMode: 'invite-only',
            snapshotVersion: groupRevision,
            metadataVersion: 1
        }
    };
}

function groupSnapshotWithActiveSession(groupId: string, generationId: string): GroupSnapshot {
    const snapshot = groupSnapshot(groupId);
    return {
        ...snapshot,
        causalRevision: {
            ...snapshot.causalRevision,
            presenceRevision: snapshot.causalRevision.presenceRevision + 1
        },
        group: {
            ...snapshot.group,
            presenceVersion: snapshot.group.presenceVersion + 1
        },
        activeSessions: [
            {
                ...createActiveGroupPresenceSessionFixture({
                    applicationId: snapshot.group.applicationId,
                    workspaceId: snapshot.group.workspaceId,
                    groupId,
                    principalId: 'principal-1',
                    sessionId: 'session-1'
                }),
                generationId,
                expiresAtEpochMs: 121_000
            }
        ],
        onlineMemberCount: 1
    };
}

function withoutMutationRequestPath(url: string): string {
    return url.replace(/\/requests\/[A-Za-z0-9_-]+$/u, '');
}

function readMutationRequestId(url: string): string | undefined {
    return url.match(/\/requests\/([A-Za-z0-9_-]+)$/u)?.[1];
}

function hasRequestId<Value>(value: Value): boolean {
    return typeof value === 'object' && value !== null && 'requestId' in value;
}
