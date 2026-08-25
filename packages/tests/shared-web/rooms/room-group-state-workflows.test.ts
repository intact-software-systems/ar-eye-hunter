import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import * as roomWorkflows from '@shared-web/browser/rooms/room-group-state-workflows.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchCall {
    readonly url: string;
    readonly requestId?: string;
    readonly method: string;
    readonly rawBody?: string;
    readonly body?: Record<string, unknown>;
}

describe('room group-state workflows', () => {
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
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('creates a generated room before connecting its presence', async () => {
        stubUuids('generated-room', 'create-request-00000001', 'presence-request-000001');
        stubSuccessfulGroupFetch(fetchCalls);

        await roomWorkflows.createAndJoinStateGroup({
            displayName: 'My Room',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1'
        });

        expect(fetchCalls).toEqual([
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups',
                requestId: 'create-request-00000001',
                method: 'POST',
                rawBody: '{"groupId":"generated-room","slug":"my-room","displayName":"My Room",' +
                    '"kind":"room","joinMode":"invite-only","createdByPrincipalId":"principal-1",' +
                    '"actorPrincipalId":"principal-1","actorSessionId":"session-1","metadata":{}}',
                body: {
                    groupId: 'generated-room',
                    slug: 'my-room',
                    displayName: 'My Room',
                    kind: 'room',
                    joinMode: 'invite-only',
                    createdByPrincipalId: 'principal-1',
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1',
                    metadata: {}
                }
            },
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/generated-room/sessions/session-1',
                requestId: 'presence-request-000001',
                method: 'PUT',
                rawBody: '{"principalId":"principal-1","generationId":"generation-1",' +
                    '"actorPrincipalId":"principal-1","actorSessionId":"session-1"}',
                body: {
                    principalId: 'principal-1',
                    generationId: 'generation-1',
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1'
                }
            }
        ]);
    });

    it('preserves explicit room identity and every safe create field', async () => {
        stubUuids('create-request-00000001', 'presence-request-000001');
        stubSuccessfulGroupFetch(fetchCalls);

        await roomWorkflows.createAndJoinStateGroup({
            displayName: 'Rallar',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            requestedGroupId: 'rallar',
            options: {
                description: 'Mission room',
                joinMode: 'open',
                maxMembers: 8,
                maxSessionsPerMember: 2,
                metadata: { map: 'fjord' },
                expiresAtEpochMs: 2_000,
                purgeAfterEpochMs: 3_000
            }
        });

        expect(fetchCalls).toEqual([
            {
                url: '/api/state/apps/app-1/workspaces/workspace-1/groups',
                requestId: 'create-request-00000001',
                method: 'POST',
                rawBody: '{"groupId":"rallar","slug":"rallar","displayName":"Rallar","kind":"room",' +
                    '"description":"Mission room","joinMode":"open","maxMembers":8,' +
                    '"maxSessionsPerMember":2,"createdByPrincipalId":"principal-1",' +
                    '"actorPrincipalId":"principal-1","actorSessionId":"session-1",' +
                    '"metadata":{"map":"fjord"},' +
                    '"expiresAtEpochMs":2000,"purgeAfterEpochMs":3000}',
                body: {
                    groupId: 'rallar',
                    slug: 'rallar',
                    displayName: 'Rallar',
                    kind: 'room',
                    description: 'Mission room',
                    joinMode: 'open',
                    maxMembers: 8,
                    maxSessionsPerMember: 2,
                    createdByPrincipalId: 'principal-1',
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1',
                    metadata: { map: 'fjord' },
                    expiresAtEpochMs: 2_000,
                    purgeAfterEpochMs: 3_000
                }
            },
            {
                url: '/api/state/apps/app-1/workspaces/workspace-1/groups/rallar/sessions/session-1',
                requestId: 'presence-request-000001',
                method: 'PUT',
                rawBody: '{"principalId":"principal-1","generationId":"generation-1",' +
                    '"actorPrincipalId":"principal-1","actorSessionId":"session-1"}',
                body: {
                    principalId: 'principal-1',
                    generationId: 'generation-1',
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1'
                }
            }
        ]);
    });

    it('keeps create and presence request IDs stable across retries', async () => {
        stubUuids(
            'retry-room',
            'create-request-00000001',
            'presence-request-000001',
            'unused-request-0000001'
        );
        stubTransientGroupFetch(fetchCalls, '/groups', '/sessions/session-1');

        await roomWorkflows.createAndJoinStateGroup({
            displayName: 'Retry Room',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } }
        });

        expect(readRequestIds(fetchCalls, 'POST', '/groups')).toEqual([
            'create-request-00000001',
            'create-request-00000001'
        ]);
        expect(readRequestIds(fetchCalls, 'PUT', '/sessions/session-1')).toEqual([
            'presence-request-000001',
            'presence-request-000001'
        ]);
    });

    it('joins membership before presence with literal intent and identity fields', async () => {
        stubUuids('join-request-00000001', 'presence-request-000001');
        stubSuccessfulGroupFetch(fetchCalls);

        await roomWorkflows.joinStateGroup({
            groupId: 'group-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            intent: { inviteToken: 'invite-1', joinCode: 'code-1' }
        });

        expect(fetchCalls).toEqual([
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/join',
                requestId: 'join-request-00000001',
                method: 'POST',
                rawBody: '{"inviteToken":"invite-1","joinCode":"code-1",' +
                    '"actorPrincipalId":"principal-1","actorSessionId":"session-1"}',
                body: {
                    inviteToken: 'invite-1',
                    joinCode: 'code-1',
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1'
                }
            },
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/session-1',
                requestId: 'presence-request-000001',
                method: 'PUT',
                rawBody: '{"principalId":"principal-1","generationId":"generation-1",' +
                    '"actorPrincipalId":"principal-1","actorSessionId":"session-1"}',
                body: {
                    principalId: 'principal-1',
                    generationId: 'generation-1',
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1'
                }
            }
        ]);
    });

    it('keeps join and presence request IDs stable across retries', async () => {
        stubUuids('join-request-00000001', 'presence-request-000001', 'unused-request-0000001');
        stubTransientGroupFetch(fetchCalls, '/join', '/sessions/session-1');

        await roomWorkflows.joinStateGroup({
            groupId: 'group-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } }
        });

        expect(readRequestIds(fetchCalls, 'POST', '/join')).toEqual([
            'join-request-00000001',
            'join-request-00000001'
        ]);
        expect(readRequestIds(fetchCalls, 'PUT', '/sessions/session-1')).toEqual([
            'presence-request-000001',
            'presence-request-000001'
        ]);
    });

    it('continues leave after missing presence with exact disconnect and member requests', async () => {
        stubUuids('disconnect-request-0001', 'member-request-0000001');
        stubLeaveFetch(fetchCalls, true);

        await roomWorkflows.leaveStateGroup({
            groupId: 'group-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1'
        });

        expect(fetchCalls).toEqual([
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/session-1/disconnect',
                requestId: 'disconnect-request-0001',
                method: 'POST',
                rawBody: '{"generationId":"generation-1","principalId":"principal-1",' +
                    '"actorPrincipalId":"principal-1","actorSessionId":"session-1",' +
                    '"reason":"left-group"}',
                body: {
                    generationId: 'generation-1',
                    principalId: 'principal-1',
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1',
                    reason: 'left-group'
                }
            },
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/members/principal-1',
                requestId: 'member-request-0000001',
                method: 'PUT',
                rawBody: '{"status":"left","actorPrincipalId":"principal-1",' +
                    '"actorSessionId":"session-1","reason":"left-group"}',
                body: {
                    status: 'left',
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1',
                    reason: 'left-group'
                }
            }
        ]);
    });

    it('keeps disconnect and member request IDs stable across leave retries', async () => {
        stubUuids('disconnect-request-0001', 'member-request-0000001', 'unused-request-0000001');
        stubTransientGroupFetch(fetchCalls, '/disconnect', '/members/principal-1');

        await roomWorkflows.leaveStateGroup({
            groupId: 'group-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            generationId: 'generation-1',
            policies: { command: { maxAttempts: 2 } }
        });

        expect(readRequestIds(fetchCalls, 'POST', '/disconnect')).toEqual([
            'disconnect-request-0001',
            'disconnect-request-0001'
        ]);
        expect(readRequestIds(fetchCalls, 'PUT', '/members/principal-1')).toEqual([
            'member-request-0000001',
            'member-request-0000001'
        ]);
    });
});

function stubUuids(...values: string[]): void {
    const spy = vi.spyOn(crypto, 'randomUUID');
    for (const value of values) {
        spy.mockReturnValueOnce(value as ReturnType<typeof crypto.randomUUID>);
    }
}

function stubSuccessfulGroupFetch(fetchCalls: FetchCall[]): void {
    stubFetch(fetchCalls, ({ url }) => jsonResponse(groupSnapshot(readGroupId(url))));
}

function stubTransientGroupFetch(
    fetchCalls: FetchCall[],
    firstSuffix: string,
    secondSuffix: string
): void {
    const attempts = new Map<string, number>();
    stubFetch(fetchCalls, ({ url }) => {
        const key = url.endsWith(firstSuffix) ? firstSuffix : secondSuffix;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        return attempt === 1
            ? new Response('transient', { status: 503 })
            : jsonResponse(groupSnapshot(readGroupId(url)));
    });
}

function stubLeaveFetch(fetchCalls: FetchCall[], disconnectMissing: boolean): void {
    stubFetch(fetchCalls, ({ url }) =>
        disconnectMissing && url.endsWith('/disconnect')
            ? new Response('missing', { status: 404 })
            : jsonResponse(groupSnapshot(readGroupId(url))));
}

function stubFetch(fetchCalls: FetchCall[], handler: (call: FetchCall) => Response): void {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const physicalUrl = String(input);
        const rawBody = init?.body ? String(init.body) : undefined;
        const call = {
            url: withoutMutationRequestPath(physicalUrl),
            requestId: readMutationRequestId(physicalUrl),
            method: init?.method ?? 'GET',
            rawBody,
            body: rawBody ? JSON.parse(rawBody) : undefined
        };
        fetchCalls.push(call);
        return Promise.resolve(handler(call));
    });
}

function readRequestIds(
    fetchCalls: readonly FetchCall[],
    method: string,
    suffix: string
): unknown[] {
    return fetchCalls
        .filter((call) => call.method === method && call.url.endsWith(suffix))
        .map((call) => call.requestId);
}

function withoutMutationRequestPath(url: string): string {
    return url.replace(/\/requests\/[A-Za-z0-9_-]+$/u, '');
}

function readMutationRequestId(url: string): string | undefined {
    return url.match(/\/requests\/([A-Za-z0-9_-]+)$/u)?.[1];
}

function readGroupId(url: string): string {
    return url.match(/\/groups\/([^/]+)/)?.[1] ?? 'generated-room';
}

function groupSnapshot(groupId: string): GroupSnapshot {
    return createGroupSnapshotFixture({
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId,
        sessionIds: []
    });
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}
