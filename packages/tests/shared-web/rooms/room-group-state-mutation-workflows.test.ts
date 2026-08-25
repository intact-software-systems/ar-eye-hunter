import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import * as mutationWorkflows from '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts';
import { rotateStateGroupJoinCode } from '@shared-web/browser/rooms/room-membership-group-state-workflows.ts';
import { readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchCall {
    readonly url: string;
    readonly method: string;
    readonly rawBody?: string;
    readonly body?: Record<string, unknown>;
}

describe('room group-state mutation workflows', () => {
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

    it('reads and merges current metadata before writing the room update', async () => {
        stubUuids('metadata-request-000001');
        const current = roomSnapshot('group-1', {
            keep: true,
            rallarDirector: { old: true }
        });
        stubFetch(fetchCalls, ({ method }) => {
            const body = method === 'GET'
                ? current
                : roomSnapshot('group-1', { keep: true, rallarDirector: { next: true } });
            return method === 'GET' ? groupPointResponse(body) : jsonResponse(body);
        });

        await mutationWorkflows.updateStateGroupMetadata({
            groupId: 'group-1',
            patch: { rallarDirector: { next: true } },
            principalId: 'principal-1',
            sessionId: 'session-1'
        });

        expect(fetchCalls).toEqual([
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1',
                method: 'GET',
                rawBody: undefined,
                body: undefined
            },
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/' +
                    'requests/metadata-request-000001',
                method: 'PUT',
                rawBody: '{"metadata":{"keep":true,"rallarDirector":{"next":true}},' +
                    '"actorPrincipalId":"principal-1","actorSessionId":"session-1"}',
                body: {
                    metadata: { keep: true, rallarDirector: { next: true } },
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1'
                }
            }
        ]);
    });

    it('writes exact detail archive and delete mutations through the shared update path', async () => {
        stubUuids('details-request-0000001', 'archive-request-0000001', 'delete-request-00000001');
        stubFetch(fetchCalls, () => jsonResponse(roomSnapshot('group-1')));

        await mutationWorkflows.updateStateGroupDetails({
            groupId: 'group-1',
            request: {
                displayName: 'Renamed',
                description: 'Mission room',
                joinMode: 'open',
                maxMembers: 8,
                maxSessionsPerMember: 2,
                metadata: { map: 'fjord', enabled: false, note: null },
                traceId: 'details-trace'
            },
            principalId: 'owner-1',
            sessionId: 'owner-session'
        });
        await mutationWorkflows.archiveStateGroup({
            groupId: 'group-1',
            request: {
                displayName: 'Archived Room',
                description: '',
                maxMembers: 0,
                metadata: { enabled: false, note: null },
                reason: 'quiet',
                traceId: 'archive-trace'
            },
            principalId: 'owner-1',
            sessionId: 'owner-session'
        });
        await mutationWorkflows.deleteStateGroup({
            groupId: 'group-1',
            request: {
                slug: 'deleted-room',
                purgeAfterEpochMs: 3_000,
                reason: 'cleanup',
                traceId: 'delete-trace'
            },
            principalId: 'owner-1',
            sessionId: 'owner-session'
        });

        expect(fetchCalls).toEqual([
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/' +
                    'requests/details-request-0000001',
                method: 'PUT',
                rawBody: '{"displayName":"Renamed","description":"Mission room","joinMode":"open",' +
                    '"maxMembers":8,"maxSessionsPerMember":2,' +
                    '"metadata":{"map":"fjord","enabled":false,"note":null},' +
                    '"traceId":"details-trace","actorPrincipalId":"owner-1",' +
                    '"actorSessionId":"owner-session"}',
                body: {
                    displayName: 'Renamed',
                    description: 'Mission room',
                    joinMode: 'open',
                    maxMembers: 8,
                    maxSessionsPerMember: 2,
                    metadata: { map: 'fjord', enabled: false, note: null },
                    traceId: 'details-trace',
                    actorPrincipalId: 'owner-1',
                    actorSessionId: 'owner-session'
                }
            },
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/' +
                    'requests/archive-request-0000001',
                method: 'PUT',
                rawBody: '{"displayName":"Archived Room","description":"","maxMembers":0,' +
                    '"metadata":{"enabled":false,"note":null},"reason":"quiet",' +
                    '"traceId":"archive-trace","status":"archived",' +
                    '"actorPrincipalId":"owner-1","actorSessionId":"owner-session"}',
                body: {
                    displayName: 'Archived Room',
                    description: '',
                    maxMembers: 0,
                    metadata: { enabled: false, note: null },
                    reason: 'quiet',
                    traceId: 'archive-trace',
                    status: 'archived',
                    actorPrincipalId: 'owner-1',
                    actorSessionId: 'owner-session'
                }
            },
            {
                url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/' +
                    'requests/delete-request-00000001',
                method: 'PUT',
                rawBody: '{"slug":"deleted-room","purgeAfterEpochMs":3000,"reason":"cleanup",' +
                    '"traceId":"delete-trace","status":"deleted",' +
                    '"actorPrincipalId":"owner-1","actorSessionId":"owner-session"}',
                body: {
                    slug: 'deleted-room',
                    purgeAfterEpochMs: 3_000,
                    reason: 'cleanup',
                    traceId: 'delete-trace',
                    status: 'deleted',
                    actorPrincipalId: 'owner-1',
                    actorSessionId: 'owner-session'
                }
            }
        ]);
    });

    it('rotates a room join code with an exact scoped request', async () => {
        stubUuids('join-code-request-0001');
        const response = {
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            snapshot: roomSnapshot('group-1')
        };
        stubFetch(fetchCalls, () => jsonResponse(response));

        await expect(
            rotateStateGroupJoinCode({
                groupId: 'group-1',
                request: { joinCode: 'code-1', expiresAtEpochMs: 2_000 },
                actorPrincipalId: 'owner-1',
                sessionId: 'owner-session',
                scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
            })
        ).resolves.toEqual(response);

        expect(fetchCalls).toEqual([
            {
                url: '/api/state/apps/app-1/workspaces/workspace-1/groups/group-1/' +
                    'join-code/rotate/requests/join-code-request-0001',
                method: 'POST',
                rawBody: '{"joinCode":"code-1","expiresAtEpochMs":2000,' +
                    '"actorPrincipalId":"owner-1","actorSessionId":"owner-session"}',
                body: {
                    joinCode: 'code-1',
                    expiresAtEpochMs: 2_000,
                    actorPrincipalId: 'owner-1',
                    actorSessionId: 'owner-session'
                }
            }
        ]);
    });
});

function stubUuids(...values: string[]): void {
    const spy = vi.spyOn(crypto, 'randomUUID');
    for (const value of values) {
        spy.mockReturnValueOnce(value as ReturnType<typeof crypto.randomUUID>);
    }
}

function stubFetch(fetchCalls: FetchCall[], handler: (call: FetchCall) => Response): void {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const rawBody = init?.body ? String(init.body) : undefined;
        const call = {
            url: String(input),
            method: init?.method ?? 'GET',
            rawBody,
            body: rawBody ? JSON.parse(rawBody) : undefined
        };
        fetchCalls.push(call);
        return Promise.resolve(handler(call));
    });
}

function roomSnapshot(groupId: string, metadata: Record<string, unknown> = {}): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId,
        sessionIds: []
    });
    return { ...snapshot, group: { ...snapshot.group, metadata } };
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function groupPointResponse(body: GroupSnapshot): Response {
    const revision = readGroupCausalRevision(body);
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(revision.groupRevision),
            'rallar-presence-revision': String(revision.presenceRevision)
        }
    });
}
