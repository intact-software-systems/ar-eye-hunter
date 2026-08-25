import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { refreshStateHeartbeat } from '@shared-web/browser/session/refresh-state-heartbeat.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveGroupPresenceSessionFixture, createClientSnapshotFixture, createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchCall {
    readonly url: string;
    readonly physicalUrl: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: object;
}

const clientData: ClientInfo = {
    clientId: 'principal-1',
    sessionId: 'session-1',
    isOnline: true
};

describe('state heartbeat HTTP workflow', () => {
    beforeEach(installEmptyLocalStorage);

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('heartbeats client and groups while tolerating one missing group presence', async () => {
        const calls: FetchCall[] = [];
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        stubFetch(calls, ({ url, method }) => {
            if (method === 'POST' && url.includes('/clients/principal-1/')) {
                return jsonResponse(clientSnapshot('principal-1'));
            }
            if (method === 'POST' && url.includes('/groups/group-1/')) {
                return jsonResponse(groupSnapshot('group-1'));
            }
            if (method === 'POST' && url.includes('/groups/group-2/')) {
                return new Response('missing', { status: 404 });
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
        expect(result.heartbeatAtEpochMs).toBe(1_000);
        expect(result.expiresAtEpochMs).toBe(121_000);
        expect(calls.filter((call) => call.url.includes('/groups/group-2/'))).toHaveLength(1);
        expect(calls.find((call) => call.url.includes('/groups/group-1/'))?.body).toMatchObject({
            generationId: 'accepted-group-generation'
        });
        expect(calls.every((call) => !hasRequestId(call.body))).toBe(true);
    });

    it('repairs missing client presence once after a scoped heartbeat 404', async () => {
        const calls: FetchCall[] = [];
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const clientSessionPath = '/api/state/apps/ar-eye-hunter/workspaces/default/clients/principal-1' +
            '/instances/principal-1/sessions/session-1';
        const groupSessionPath = '/api/state/apps/ar-eye-hunter/workspaces/default/groups/group-1' +
            '/sessions/session-1';
        stubFetch(calls, ({ url, method }) => {
            if (method === 'POST' && url === `${clientSessionPath}/heartbeat`) {
                return new Response('Client principal not found: principal-1', { status: 404 });
            }
            if (method === 'PUT' && url === clientSessionPath) {
                return jsonResponse(clientSnapshot('principal-1', 'ar-eye-hunter'));
            }
            if (method === 'POST' && url === `${groupSessionPath}/heartbeat`) {
                return jsonResponse(groupSnapshot('group-1', 'ar-eye-hunter'));
            }
            return notFoundResponse();
        });

        const result = await refreshStateHeartbeat(
            clientData,
            [groupSnapshot('group-1', 'ar-eye-hunter')],
            {
                generationId: 'generation-1',
                scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' },
                policies: { command: { maxAttempts: 3 } }
            }
        );

        expect(result.groups.map((group) => group.group.groupId)).toEqual(['group-1']);
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            `POST ${clientSessionPath}/heartbeat`,
            `PUT ${clientSessionPath}`,
            `POST ${groupSessionPath}/heartbeat`
        ]);
        expect(calls[1].body).toMatchObject({
            actorPrincipalId: 'principal-1',
            actorSessionId: 'session-1',
            generationId: 'generation-1',
            presenceState: 'online',
            transport: 'ws',
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 121_000
        });
    });

    it('reuses distinct client and group request IDs across retries', async () => {
        const calls: FetchCall[] = [];
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('client-heartbeat-request-001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('client-repair-request-0001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('group-heartbeat-request-0001' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unused-request-0000001' as ReturnType<typeof crypto.randomUUID>);
        let clientAttempts = 0;
        let groupAttempts = 0;
        stubFetch(calls, ({ url, method }) => {
            if (method === 'POST' && url.includes('/clients/principal-1/')) {
                clientAttempts += 1;
                return clientAttempts === 1
                    ? new Response('transient client failure', { status: 503 })
                    : jsonResponse(clientSnapshot('principal-1'));
            }
            if (method === 'POST' && url.includes('/groups/group-1/')) {
                groupAttempts += 1;
                return groupAttempts === 1
                    ? new Response('transient group failure', { status: 503 })
                    : jsonResponse(groupSnapshot('group-1'));
            }
            return notFoundResponse();
        });

        await refreshStateHeartbeat(clientData, [groupSnapshot('group-1')], {
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } }
        });

        const clientRequestIds = requestIdsFor(calls, '/clients/principal-1/');
        const groupRequestIds = requestIdsFor(calls, '/groups/group-1/');
        expect(clientRequestIds).toEqual([
            'client-heartbeat-request-001',
            'client-heartbeat-request-001'
        ]);
        expect(groupRequestIds).toEqual([
            'group-heartbeat-request-0001',
            'group-heartbeat-request-0001'
        ]);
    });

    it('reuses a dedicated presence-repair request ID across retries', async () => {
        const calls: FetchCall[] = [];
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('client-heartbeat-request-id' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValueOnce('client-repair-request-id' as ReturnType<typeof crypto.randomUUID>)
            .mockReturnValue('unexpected-request-id' as ReturnType<typeof crypto.randomUUID>);
        let repairAttempts = 0;
        stubFetch(calls, ({ url, method }) => {
            if (method === 'POST' && url.includes('/heartbeat')) {
                return new Response('presence missing', { status: 404 });
            }
            if (method === 'PUT' && url.endsWith('/sessions/session-1')) {
                repairAttempts += 1;
                return repairAttempts === 1
                    ? new Response('repair response lost', { status: 503 })
                    : jsonResponse(clientSnapshot('principal-1'));
            }
            return notFoundResponse();
        });

        await refreshStateHeartbeat(clientData, [], {
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } }
        });

        expect(calls.filter((call) => call.method === 'PUT').map((call) => readMutationRequestId(call.physicalUrl))).toEqual([
            'client-repair-request-id',
            'client-repair-request-id'
        ]);
    });

    it('forwards the provided auth session', async () => {
        const calls: FetchCall[] = [];
        stubFetch(calls, () => jsonResponse(clientSnapshot('principal-1')));

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

        expect(calls).toHaveLength(1);
        expect(calls[0].headers.authorization).toBe('Bearer token-1');
        expect(calls[0].headers['x-client-id']).toBe('principal-1');
    });
});

function stubFetch(
    calls: FetchCall[],
    respond: (call: FetchCall) => Response | Promise<Response>
): void {
    vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const physicalUrl = String(input);
            const call = {
                url: physicalUrl.replace(/\/requests\/[A-Za-z0-9_-]+$/u, ''),
                physicalUrl,
                method: init?.method ?? 'GET',
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
                body: init?.body ? JSON.parse(String(init.body)) : undefined
            };
            calls.push(call);
            return respond(call);
        })
    );
}

function jsonResponse(body: object): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function notFoundResponse(): Response {
    return new Response('not found', { status: 404 });
}

function clientSnapshot(principalId: string, applicationId = 'rallar-server'): ClientSnapshot {
    return createClientSnapshotFixture({
        applicationId,
        workspaceId: 'default',
        principalId
    });
}

function groupSnapshot(groupId: string, applicationId = 'rallar-server'): GroupSnapshot {
    return createGroupSnapshotFixture({
        applicationId,
        workspaceId: 'default',
        groupId,
        sessionIds: []
    });
}

function groupSnapshotWithActiveSession(groupId: string, generationId: string): GroupSnapshot {
    const snapshot = groupSnapshot(groupId);
    return {
        ...snapshot,
        activeSessions: [{
            ...createActiveGroupPresenceSessionFixture({
                applicationId: snapshot.group.applicationId,
                workspaceId: snapshot.group.workspaceId,
                groupId,
                principalId: 'principal-1',
                sessionId: 'session-1'
            }),
            generationId,
            expiresAtEpochMs: 121_000
        }],
        onlineMemberCount: 1
    };
}

function requestIdsFor(calls: readonly FetchCall[], path: string): Array<string | undefined> {
    return calls
        .filter((call) => call.method === 'POST' && call.physicalUrl.includes(path))
        .map((call) => readMutationRequestId(call.physicalUrl));
}

function readMutationRequestId(url: string): string | undefined {
    return url.match(/\/requests\/([A-Za-z0-9_-]+)$/u)?.[1];
}

function hasRequestId(body: object | undefined): boolean {
    return body !== undefined && 'requestId' in body;
}

function installEmptyLocalStorage(): void {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn()
    });
}
