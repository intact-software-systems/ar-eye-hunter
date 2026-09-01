import { decodeJsonWireText, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { toCreateWsUrl } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { initHeartbeat } from '@shared-web/browser/session/browser-session-heartbeat.ts';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import {
    createActiveClientInstanceFixture,
    createActiveClientSessionFixture,
    createActiveGroupMemberFixture,
    createActiveGroupPresenceSessionFixture,
    createClientSnapshotFixture,
    createGroupSnapshotFixture
} from '../authoritative-group-fixtures.ts';

interface FetchCall {
    readonly url: string;
    readonly method: string;
    readonly body: JsonWireValue | undefined;
}

describe('Browser session heartbeat', () => {
    const fetchCalls: FetchCall[] = [];
    const authSession: AuthSession = {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000
    };
    const clientData: ClientInfo = {
        clientId: authSession.clientId,
        sessionId: authSession.sessionId,
        isOnline: true
    };

    beforeEach(() => {
        fetchCalls.length = 0;
        configureApiClient({ apiBaseUrl: '' });
        configureTestCacheRepositories();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('threads the active state scope into the websocket connection URL', () => {
        const url = toCreateWsUrl({
            apiConfig: {
                apiBaseUrl: 'https://api.example.test',
                wsBaseUrl: 'wss://api.example.test',
                endpoints: {
                    createWs: '/api/ws/:id'
                }
            },
            session: authSession,
            ticket: 'ticket-1',
            scope: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default'
            }
        });

        expect(url).toBe(
            'wss://api.example.test/api/ws/session-1?ticket=ticket-1&applicationId=ar-eye-hunter&workspaceId=default'
        );
    });

    it('uses the active scope and prunes a cached group after an authoritative heartbeat 404', async () => {
        const staleGroup = groupSnapshot({
            groupId: 'stale-room',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: authSession.clientId,
            sessionId: authSession.sessionId
        });
        groupStateSnapshotsRepository.setGroupStateSnapshots([staleGroup]);
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.includes('/sessions/session-1/heartbeat/requests/')
            ) {
                return jsonResponse(clientSnapshot('principal-1'));
            }

            if (
                method === 'POST' &&
                url.includes('/groups/stale-room/') &&
                url.includes('/sessions/session-1/heartbeat/requests/')
            ) {
                return textResponse('Group presence session not found: session-1', 404);
            }

            return textResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            authSession,
            scope: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default'
            },
            policies: { command: { maxAttempts: 3 } }
        });

        await vi.waitFor(() => {
            expect(fetchCalls.filter((call) => call.url.includes('/heartbeat'))).toHaveLength(2);
        });
        handle.stop();
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        const clientHeartbeatRequestPath = [
            '/api/state/apps/ar-eye-hunter/workspaces/default',
            '/clients/principal-1/instances/principal-1',
            '/sessions/session-1/heartbeat/requests/'
        ].join('');
        expect(fetchCalls[0]?.url.startsWith(clientHeartbeatRequestPath)).toBe(true);
        expect(fetchCalls[0]?.url.slice(clientHeartbeatRequestPath.length)).toMatch(/^[^/]+$/);
        const groupHeartbeatRequestPath = [
            '/api/state/apps/ar-eye-hunter/workspaces/default',
            '/groups/stale-room/sessions/session-1/heartbeat/requests/'
        ].join('');
        expect(fetchCalls[1]?.url.startsWith(groupHeartbeatRequestPath)).toBe(true);
        expect(fetchCalls[1]?.url.slice(groupHeartbeatRequestPath.length)).toMatch(/^[^/]+$/);
        expect(handle.generationId).toBeTruthy();
        expect(fetchCalls[0]?.body).toMatchObject({
            generationId: handle.generationId
        });
        expect(fetchCalls.every((call) => !hasRequestId(call.body))).toBe(true);
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(staleGroup.group)
        ).toBeUndefined();
    });

    it('preserves a newer group publication that races an authoritative heartbeat 404', async () => {
        const observed = groupSnapshot({
            groupId: 'stale-room',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: authSession.clientId,
            sessionId: authSession.sessionId
        });
        const newer: GroupSnapshot = {
            ...observed,
            group: { ...observed.group, snapshotVersion: observed.group.snapshotVersion + 1 },
            causalRevision: {
                groupRevision: observed.causalRevision.groupRevision + 1,
                presenceRevision: observed.causalRevision.presenceRevision
            }
        };
        groupStateSnapshotsRepository.setGroupStateSnapshots([observed]);
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.includes('/clients/principal-1/')) {
                return jsonResponse(clientSnapshot('principal-1'));
            }
            if (method === 'POST' && url.includes('/groups/stale-room/')) {
                groupStateSnapshotsRepository.setGroupStateSnapshots([newer]);
                return textResponse('Group presence session not found: session-1', 404);
            }
            return textResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.waitFor(() => {
            expect(fetchCalls.filter((call) => call.url.includes('/heartbeat'))).toHaveLength(2);
        });
        handle.stop();
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(observed.group)).toBe(newer);
    });

    it('stops and reports auth invalidation after a single client heartbeat 401', async () => {
        let authInvalidated = false;
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.includes('/sessions/session-1/heartbeat/requests/')
            ) {
                return textResponse('Unauthorized', 401);
            }

            return textResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            authSession,
            scope: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default'
            },
            policies: { command: { maxAttempts: 3 } },
            onAuthInvalid: () => {
                authInvalidated = true;
            }
        });

        await vi.waitFor(() => {
            expect(authInvalidated).toBe(true);
        });
        handle.stop();

        expect(fetchCalls.map((call) => call.url)).toEqual([
            expect.stringContaining('/heartbeat')
        ]);
    });

    it('uses one generation for an active heartbeat and allocates a new one after restart', async () => {
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.includes('/sessions/session-1/heartbeat/requests/')
            ) {
                return jsonResponse(clientSnapshot('principal-1'));
            }

            return textResponse('unexpected', 500);
        });

        const first = await initHeartbeat(clientData, { authSession });
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
        expect(fetchCalls[0]?.body).toMatchObject({
            generationId: first.generationId
        });

        const second = await initHeartbeat(clientData, { authSession });
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(2));
        second.stop();

        expect(second.generationId).not.toBe(first.generationId);
        expect(fetchCalls[1]?.body).toMatchObject({
            generationId: second.generationId
        });
    });

    function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
        vi.stubGlobal(
            'fetch',
            vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
                const call: FetchCall = {
                    url: String(input),
                    method: init?.method ?? 'GET',
                    body: init?.body ? decodeJsonWireText(String(init.body)) : undefined
                };
                fetchCalls.push(call);
                return handler(call);
            })
        );
    }
});

function jsonResponse(body: ClientSnapshot, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

function textResponse(body: string, status: number): Response {
    return new Response(body, { status });
}

function hasRequestId(value: JsonWireValue | undefined): boolean {
    return typeof value === 'object' && value !== null && 'requestId' in value;
}

function clientSnapshot(principalId: string): ClientSnapshot {
    const snapshot = createClientSnapshotFixture({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        principalId
    });
    return {
        ...snapshot,
        principal: { ...snapshot.principal, snapshotVersion: 2 },
        instances: [
            createActiveClientInstanceFixture({
                applicationId: snapshot.principal.applicationId,
                workspaceId: snapshot.principal.workspaceId,
                principalId,
                clientInstanceId: principalId
            })
        ],
        activeSessions: [
            createActiveClientSessionFixture({
                applicationId: snapshot.principal.applicationId,
                workspaceId: snapshot.principal.workspaceId,
                principalId,
                clientInstanceId: principalId,
                sessionId: 'session-1'
            })
        ],
        isOnline: true,
        activeSessionCount: 1
    };
}

interface GroupSnapshotFixtureInput {
    readonly groupId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sessionId: string;
}

function groupSnapshot(input: GroupSnapshotFixtureInput): GroupSnapshot {
    const { applicationId, groupId, principalId, sessionId, workspaceId } = input;
    const snapshot = createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds: []
    });
    return {
        ...snapshot,
        causalRevision: { groupRevision: 3, presenceRevision: 1 },
        group: {
            ...snapshot.group,
            slug: groupId,
            joinMode: 'invite-only',
            snapshotVersion: 3,
            presenceVersion: 1,
            metadataVersion: 1,
            activeMemberCount: 1,
            ownerPrincipalId: principalId
        },
        members: [
            createActiveGroupMemberFixture({
                applicationId,
                workspaceId,
                groupId,
                principalId,
                role: 'owner',
                actorPrincipalId: principalId
            })
        ],
        activeSessions: [
            createActiveGroupPresenceSessionFixture({
                applicationId,
                workspaceId,
                groupId,
                sessionId,
                principalId
            })
        ],
        memberCount: 1,
        onlineMemberCount: 1
    };
}
