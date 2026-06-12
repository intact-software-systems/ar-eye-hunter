import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { initHeartbeat } from '@shared-web/browser/heartbeat.ts';
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
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(staleGroup.group),
        ).toBeUndefined();
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

function groupSnapshot(
    groupId: string,
    applicationId: string,
    workspaceId: string,
    principalId: string,
    sessionId: string,
): GroupSnapshot {
    return {
        group: {
            applicationId,
            workspaceId,
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
        members: [{
            applicationId,
            workspaceId,
            groupId,
            principalId,
            role: 'member',
            status: 'active',
            joined: { atEpochMs: 1 },
            updated: { atEpochMs: 1 },
        }],
        activeSessions: [{
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        }],
        memberCount: 1,
        onlineMemberCount: 1,
    };
}
