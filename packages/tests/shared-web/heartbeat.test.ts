import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    createActiveGroupMemberFixture,
    createActiveGroupPresenceSessionFixture,
    createActiveClientSessionFixture,
    createClientSnapshotFixture,
    createGroupSnapshotFixture,
} from './authoritative-group-fixtures.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { initHeartbeat } from '@shared-web/browser/heartbeat.ts';
import { toCreateWsUrl } from '@shared-web/browser/middleware.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

type FetchCall = Readonly<{
    url: string;
    method: string;
    body?: unknown;
}>;

describe('browser heartbeat', () => {
    const fetchCalls: FetchCall[] = [];
    const authSession: AuthSession = {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000,
    };
    const clientData: ClientInfo = {
        clientId: authSession.clientId,
        sessionId: authSession.sessionId,
        isOnline: true,
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
        const url = toCreateWsUrl(
            {
                apiBaseUrl: 'https://api.example.test',
                wsBaseUrl: 'wss://api.example.test',
                endpoints: {
                    createWs: '/api/ws/:id',
                },
            },
            authSession,
            'ticket-1',
            {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
            },
        );

        expect(url).toBe(
            'wss://api.example.test/api/ws/session-1?ticket=ticket-1&applicationId=ar-eye-hunter&workspaceId=default',
        );
    });

    it('uses the active scope and prunes a cached group after an authoritative heartbeat 404', async () => {
        const staleGroup = groupSnapshot(
            'stale-room',
            'ar-eye-hunter',
            'default',
            authSession.clientId,
            authSession.sessionId,
        );
        groupStateSnapshotsRepository.setGroupStateSnapshots([staleGroup]);
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.endsWith('/sessions/session-1/heartbeat')
            ) {
                return jsonResponse(clientSnapshot('principal-1'));
            }

            if (
                method === 'POST' &&
                url.includes('/groups/stale-room/') &&
                url.endsWith('/sessions/session-1/heartbeat')
            ) {
                return textResponse('Group presence session not found: session-1', 404);
            }

            return textResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            authSession,
            scope: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
            },
            policies: { command: { maxAttempts: 3 } },
        });

        await vi.waitFor(() => {
            expect(
                fetchCalls.filter((call) => call.url.includes('/heartbeat')),
            ).toHaveLength(2);
        });
        handle.stop();
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(fetchCalls.map((call) => call.url)).toEqual([
            '/api/state/apps/ar-eye-hunter/workspaces/default/clients/principal-1/instances/principal-1/sessions/session-1/heartbeat',
            '/api/state/apps/ar-eye-hunter/workspaces/default/groups/stale-room/sessions/session-1/heartbeat',
        ]);
        expect(handle.generationId).toBeTruthy();
        expect(fetchCalls[0]?.body).toMatchObject({
            generationId: handle.generationId,
        });
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(staleGroup.group),
        ).toBeUndefined();
    });

    it('stops and reports auth invalidation after a single client heartbeat 401', async () => {
        const onAuthInvalid = vi.fn();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.endsWith('/sessions/session-1/heartbeat')
            ) {
                return textResponse('Unauthorized', 401);
            }

            return textResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            authSession,
            scope: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
            },
            policies: { command: { maxAttempts: 3 } },
            onAuthInvalid,
        });

        await vi.waitFor(() => {
            expect(onAuthInvalid).toHaveBeenCalledOnce();
        });
        handle.stop();

        expect(
            fetchCalls.filter((call) => call.url.includes('/heartbeat')),
        ).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it('uses one generation for an active heartbeat and allocates a new one after restart', async () => {
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.endsWith('/sessions/session-1/heartbeat')
            ) {
                return jsonResponse(clientSnapshot('principal-1'));
            }

            return textResponse('unexpected', 500);
        });

        const first = await initHeartbeat(clientData, { authSession });
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
        expect(fetchCalls[0]?.body).toMatchObject({
            generationId: first.generationId,
        });

        const second = await initHeartbeat(clientData, { authSession });
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(2));
        second.stop();

        expect(second.generationId).not.toBe(first.generationId);
        expect(fetchCalls[1]?.body).toMatchObject({
            generationId: second.generationId,
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

function clientSnapshot(principalId: string): ClientSnapshot {
    const snapshot = createClientSnapshotFixture({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        principalId,
    });
    return {
        ...snapshot,
        principal: { ...snapshot.principal, snapshotVersion: 2 },
        activeSessions: [createActiveClientSessionFixture({
            applicationId: snapshot.principal.applicationId,
            workspaceId: snapshot.principal.workspaceId,
            principalId,
            clientInstanceId: principalId,
            sessionId: 'session-1',
        })],
        isOnline: true,
        activeSessionCount: 1,
    };
}

function groupSnapshot(
    groupId: string,
    applicationId: string,
    workspaceId: string,
    principalId: string,
    sessionId: string,
): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds: [],
    });
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            slug: groupId,
            joinMode: 'invite-only',
            snapshotVersion: 3,
            metadataVersion: 1,
            activeMemberCount: 1,
            ownerPrincipalId: principalId,
        },
        members: [createActiveGroupMemberFixture({
            applicationId,
            workspaceId,
            groupId,
            principalId,
            role: 'member',
            actorPrincipalId: principalId,
        })],
        activeSessions: [createActiveGroupPresenceSessionFixture({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId,
        })],
        memberCount: 1,
        onlineMemberCount: 1,
    };
}
