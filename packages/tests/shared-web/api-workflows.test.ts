import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
    createAndJoinStateGroup,
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
        expect(fetchCalls[1].body).toMatchObject({
            status: 'left',
            reason: 'left-group',
        });
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
