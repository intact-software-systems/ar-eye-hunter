import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
    acceptStateGroupInvite,
    banStateGroupMember,
    createStateGroupInvite,
    removeStateGroupMember,
    revokeStateGroupInvite,
    rotateStateGroupJoinCode,
    setStateGroupMemberRole,
    transferStateGroupOwnership,
    unbanStateGroupMember
} from '@shared-web/browser/rooms/room-membership-group-state-workflows.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchCall {
    readonly url: string;
    readonly method: string;
    readonly body?: object;
}

describe('room membership group-state HTTP workflows', () => {
    const fetchCalls: FetchCall[] = [];

    beforeEach(() => {
        fetchCalls.length = 0;
        configureApiClient({ apiBaseUrl: '' });
        installEmptyLocalStorage();
    });

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('creates and revokes room invites', async () => {
        stubFetch(fetchCalls, ({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/invites/member-1')) {
                return jsonResponse(groupSnapshot('group-1'));
            }
            if (method === 'POST' && url.endsWith('/groups/group-1/invites/member-1/revoke')) {
                return jsonResponse(groupSnapshot('group-1'));
            }
            return notFoundResponse();
        });

        await createStateGroupInvite({
            groupId: 'group-1',
            targetPrincipalId: 'member-1',
            request: { invitationExpiresAtEpochMs: 2_000 },
            actorPrincipalId: 'owner-1',
            sessionId: 'owner-session'
        });
        await revokeStateGroupInvite({
            groupId: 'group-1',
            targetPrincipalId: 'member-1',
            request: {},
            actorPrincipalId: 'owner-1',
            sessionId: 'owner-session'
        });

        expect(fetchCalls.map(toMethodAndUrl)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/member-1',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1' +
            '/invites/member-1/revoke'
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            invitationExpiresAtEpochMs: 2_000,
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session'
        });
        expect(fetchCalls[1].body).toMatchObject({
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session'
        });
    });

    it('accepts a room invite before connecting presence', async () => {
        stubFetch(fetchCalls, ({ url, method }) => {
            if (method === 'POST' && url.endsWith('/groups/group-1/invites/accept')) {
                return jsonResponse(groupSnapshot('group-1'));
            }
            if (method === 'PUT' && url.endsWith('/groups/group-1/sessions/member-session')) {
                return jsonResponse(groupSnapshot('group-1'));
            }
            return notFoundResponse();
        });

        await expect(
            acceptStateGroupInvite({
                groupId: 'group-1',
                actorPrincipalId: 'member-1',
                sessionId: 'member-session',
                generationId: 'generation-1'
            })
        ).resolves.toMatchObject({ group: { groupId: 'group-1' } });

        expect(fetchCalls.map(toMethodAndUrl)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/accept',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/member-session'
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            actorPrincipalId: 'member-1',
            actorSessionId: 'member-session'
        });
        expect(fetchCalls[1].body).toMatchObject({
            principalId: 'member-1',
            generationId: 'generation-1',
            actorPrincipalId: 'member-1',
            actorSessionId: 'member-session'
        });
    });

    it('rotates a room join code', async () => {
        const response = {
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            snapshot: groupSnapshot('group-1')
        };
        stubFetch(fetchCalls, ({ url, method }) =>
            method === 'POST' && url.endsWith('/groups/group-1/join-code/rotate')
                ? jsonResponse(response)
                : notFoundResponse());

        await expect(
            rotateStateGroupJoinCode({
                groupId: 'group-1',
                request: { joinCode: 'code-1', expiresAtEpochMs: 2_000 },
                actorPrincipalId: 'owner-1',
                sessionId: 'owner-session'
            })
        ).resolves.toEqual(response);

        expect(fetchCalls.map(toMethodAndUrl)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/join-code/rotate'
        ]);
        expect(fetchCalls[0].body).toMatchObject({
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session'
        });
    });

    it('runs membership governance through owned room operations', async () => {
        stubFetch(fetchCalls, ({ url, method }) => {
            const supportedSuffixes = [
                '/groups/group-1/members/member-1/remove',
                '/groups/group-1/members/member-1/ban',
                '/groups/group-1/members/member-1/unban',
                '/groups/group-1/members/member-1/role',
                '/groups/group-1/owner/transfer'
            ];
            return (method === 'POST' || method === 'PUT') &&
                    supportedSuffixes.some((suffix) => url.endsWith(suffix))
                ? jsonResponse(groupSnapshot('group-1'))
                : notFoundResponse();
        });

        const memberAction = {
            groupId: 'group-1',
            targetPrincipalId: 'member-1',
            actorPrincipalId: 'owner-1',
            sessionId: 'owner-session'
        };
        await removeStateGroupMember({ ...memberAction, request: {} });
        await banStateGroupMember({ ...memberAction, request: {} });
        await unbanStateGroupMember({ ...memberAction, request: {} });
        await setStateGroupMemberRole({ ...memberAction, request: { role: 'admin' } });
        await transferStateGroupOwnership({
            groupId: 'group-1',
            request: { newOwnerPrincipalId: 'member-1' },
            actorPrincipalId: 'owner-1',
            sessionId: 'owner-session'
        });

        expect(fetchCalls.map(toMethodAndUrl)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1' +
            '/members/member-1/remove',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/ban',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/unban',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/role',
            'POST /api/state/apps/rallar-server/workspaces/default/groups/group-1/owner/transfer'
        ]);
        for (const call of fetchCalls) {
            expect(call.body).toMatchObject({
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session'
            });
        }
        expect(fetchCalls[3].body).toMatchObject({ role: 'admin' });
        expect(fetchCalls[4].body).toMatchObject({ newOwnerPrincipalId: 'member-1' });
    });
});

function stubFetch(
    fetchCalls: FetchCall[],
    handler: (call: FetchCall) => Response | Promise<Response>
): void {
    vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const physicalUrl = String(input);
            const call = {
                url: physicalUrl.replace(/\/requests\/[A-Za-z0-9_-]+$/u, ''),
                method: init?.method ?? 'GET',
                body: init?.body ? JSON.parse(String(init.body)) : undefined
            };
            fetchCalls.push(call);
            return handler(call);
        })
    );
}

function toMethodAndUrl(call: FetchCall): string {
    return `${call.method} ${call.url}`;
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

function groupSnapshot(groupId: string): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId,
        sessionIds: []
    });
    const groupRevision = 3;
    return {
        ...snapshot,
        causalRevision: { ...snapshot.causalRevision, groupRevision },
        group: {
            ...snapshot.group,
            slug: groupId,
            joinMode: 'invite-only',
            snapshotVersion: groupRevision,
            metadataVersion: 1
        }
    };
}

function installEmptyLocalStorage(): void {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn()
    });
}
