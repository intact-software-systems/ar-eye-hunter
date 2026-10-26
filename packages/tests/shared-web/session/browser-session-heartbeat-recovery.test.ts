import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { BrowserOwnWsConnectionGeneration } from '@shared-web/browser/connection/browser-own-ws-connection-generation.ts';
import { initHeartbeat, stopHeartbeat } from '@shared-web/browser/session/browser-session-heartbeat.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as groupSnapshots from '@shared/repository/group-state-snapshots-repository.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createClientSnapshotFixture, createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const START = 1_000_000;
const scope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };
const session: AuthSession = {
    clientId: 'alice',
    sessionId: 'alice',
    username: 'alice',
    accessToken: 'test-token',
    expiresAtEpochMs: START + 3_600_000
};
const client = { clientId: session.clientId, sessionId: session.sessionId, isOnline: true };
const groupsPath = '/api/state/apps/ar-eye-hunter/workspaces/default/groups';

interface RequestObservation {
    readonly method: string;
    readonly path: string;
    readonly authorization: string | null;
}

/** HTTP is the only substituted boundary; scheduling, cache expiry and renewal adoption stay real. */
class HeartbeatServer {
    readonly requests: RequestObservation[] = [];
    groups: GroupSnapshot[] = [joinedRoom()];
    readGroups: () => Response | Promise<Response> = () => Response.json(this.groups);

    install(): void {
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = String(input);
            const method = init?.method ?? 'GET';
            this.requests.push({ method, path, authorization: new Headers(init?.headers).get('authorization') });
            if (method === 'GET' && path === groupsPath) {
                return await this.readGroups();
            }
            if (method === 'POST' && path.includes('/clients/alice/')) {
                return Response.json(createClientSnapshotFixture({ ...scope, principalId: 'alice' }));
            }
            const group = this.groups.find((snapshot) => path.includes(`/groups/${snapshot.group.groupId}/`));
            if (method === 'POST' && path.includes('/heartbeat/requests/') && group) {
                return Response.json({
                    ...group,
                    activeSessions: group.activeSessions.map((presence) => ({
                        ...presence,
                        lastHeartbeatAtEpochMs: Date.now(),
                        expiresAtEpochMs: Date.now() + 120_000
                    }))
                });
            }
            return new Response('Presence not found', { status: 404 });
        });
    }
}

describe('heartbeat recovery after delayed callbacks', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(START);
        configureTestCacheRepositories();
        configureApiClient({ apiBaseUrl: '' });
    });
    afterEach(() => {
        stopHeartbeat();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('renews a joined private room after cache expiry while its server lease is still live', async () => {
        const server = new HeartbeatServer();
        server.install();
        groupSnapshots.setGroupStateSnapshots(server.groups);
        await initHeartbeat(client, { authSession: session, scope });

        // Move wall time without dispatching timers, then deliver the overdue first callback.
        vi.setSystemTime(START + 65_000);
        expect(groupSnapshots.getAllGroupStateSnapshots()).toEqual([]);
        await vi.advanceTimersByTimeAsync(50_000);

        expect(Date.now()).toBeLessThan(START + 120_000);
        expect(server.requests.filter((request) => request.path.includes('/groups/private-room/sessions/')))
            .toHaveLength(1);
        expect(groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)?.activeSessions[0])
            .toMatchObject({ sessionId: 'alice', lastHeartbeatAtEpochMs: START + 115_000 });
        expect(server.requests.filter((request) => request.method === 'GET')).toEqual([
            { method: 'GET', path: groupsPath, authorization: 'Bearer test-token' }
        ]);
    });
    it('does not add group-list traffic to timely renewals, and recovers after a later delay', async () => {
        const server = new HeartbeatServer();
        server.install();
        groupSnapshots.setGroupStateSnapshots(server.groups);
        await initHeartbeat(client, { authSession: session, scope });
        await vi.advanceTimersByTimeAsync(90_000);
        expect(server.requests.filter((request) => request.method === 'GET')).toEqual([]);
        expect(server.requests.filter((request) => request.path.includes('/groups/private-room/sessions/')))
            .toHaveLength(3);
        vi.setSystemTime(Date.now() + 65_000);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)?.activeSessions[0])
            .toMatchObject({ lastHeartbeatAtEpochMs: START + 175_000 });
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
    });

    it.each(['removed', 'lease-expired'] as const)('does not rejoin a room whose server presence is %s', async (reason) => {
        const server = new HeartbeatServer();
        server.install();
        const joined = server.groups[0];
        groupSnapshots.setGroupStateSnapshots([joined]);
        await initHeartbeat(client, { authSession: session, scope });
        server.groups = reason === 'removed' ? [] : [{ ...joined, activeSessions: [], onlineMemberCount: 0 }];
        await deliverDelayedFirstHeartbeat();
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
        expect(server.requests.filter((request) => request.path.startsWith(`${groupsPath}/`))).toEqual([]);
        expect(groupSnapshots.findGroupStateSnapshotByRef(joined.group)?.activeSessions ?? []).toEqual([]);
    });

    it('does not renew another session or another principal with the same session identifier', async () => {
        const server = new HeartbeatServer();
        server.install();
        const otherSession = createGroupSnapshotFixture({ ...scope, groupId: 'other-session', sessionIds: ['other'] });
        const otherPrincipal = {
            ...otherSession,
            group: { ...otherSession.group, groupId: 'other-principal' },
            members: otherSession.members.map((member) => ({ ...member, groupId: 'other-principal' })),
            activeSessions: otherSession.activeSessions.map((presence) => ({
                ...presence,
                groupId: 'other-principal',
                sessionId: 'alice'
            }))
        };
        server.groups = [otherSession, otherPrincipal];
        await initHeartbeat(client, { authSession: session, scope });
        await deliverDelayedFirstHeartbeat();
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
        expect(server.requests.filter((request) => request.path.startsWith(`${groupsPath}/`))).toEqual([]);
    });

    it('preserves an explicit leave published while the recovery read is in flight', async () => {
        const server = new HeartbeatServer();
        const response = Promise.withResolvers<Response>();
        server.readGroups = () => response.promise;
        server.install();
        const joined = server.groups[0];
        groupSnapshots.setGroupStateSnapshots([joined]);
        await initHeartbeat(client, { authSession: session, scope });
        await deliverDelayedFirstHeartbeat();
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
        const left: GroupSnapshot = {
            ...joined,
            group: { ...joined.group, snapshotVersion: 2, presenceVersion: 2 },
            causalRevision: { groupRevision: 2, presenceRevision: 2 },
            activeSessions: [],
            onlineMemberCount: 0
        };
        groupSnapshots.setGroupStateSnapshot(left);
        response.resolve(Response.json([joined]));
        await vi.advanceTimersByTimeAsync(0);
        expect(groupSnapshots.findGroupStateSnapshotByRef(joined.group)).toBe(left);
        expect(server.requests.filter((request) => request.path.startsWith(`${groupsPath}/`))).toEqual([]);
    });

    it.each(['stop', 'replace'] as const)('fences recovery adoption and requests after heartbeat %s', async (action) => {
        const server = new HeartbeatServer();
        const response = Promise.withResolvers<Response>();
        server.readGroups = () => response.promise;
        server.install();
        let connectionReads = 0;
        const ownWsConnectionGeneration = new BrowserOwnWsConnectionGeneration({
            socket: { ws: { readyState: WebSocket.OPEN } },
            sessionId: session.sessionId,
            readOwnClientSnapshot: async () => {
                connectionReads += 1;
                return createClientSnapshotFixture({ ...scope, principalId: 'alice' });
            }
        });
        await initHeartbeat(client, { authSession: session, scope, ownWsConnectionGeneration });
        await deliverDelayedFirstHeartbeat();
        expect(server.requests).toHaveLength(1);
        if (action === 'stop') {
            stopHeartbeat();
        }
        else {
            await initHeartbeat({ clientId: 'bob', sessionId: 'bob', isOnline: true }, {
                authSession: { ...session, clientId: 'bob', sessionId: 'bob', accessToken: 'new-token' },
                scope
            });
        }
        response.resolve(Response.json(server.groups));
        await vi.advanceTimersByTimeAsync(0);
        expect(connectionReads).toBe(0);
        expect(groupSnapshots.getAllGroupStateSnapshots()).toEqual([]);
        expect(server.requests).toHaveLength(1);
    });

    it('retries a failed recovery without treating it as authoritative absence', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new HeartbeatServer();
        server.readGroups = () => new Response('Unavailable', { status: 503 });
        server.install();
        await initHeartbeat(client, { authSession: session, scope });
        await deliverDelayedFirstHeartbeat();
        expect(server.requests).toHaveLength(1);
        server.readGroups = () => Response.json(server.groups);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(2);
        expect(groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)?.activeSessions[0].sessionId)
            .toBe('alice');
    });

    it('bounds a stalled recovery and retries through the existing heartbeat loop', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new HeartbeatServer();
        const stalled = Promise.withResolvers<Response>();
        server.readGroups = () => stalled.promise;
        server.install();
        await initHeartbeat(client, { authSession: session, scope });
        await deliverDelayedFirstHeartbeat();
        await vi.advanceTimersByTimeAsync(5_000);
        server.readGroups = () => Response.json(server.groups);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(2);
        const recovered = groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group);
        expect(recovered?.activeSessions[0]).toMatchObject({ lastHeartbeatAtEpochMs: START + 125_000 });
        stalled.resolve(Response.json([]));
        await vi.advanceTimersByTimeAsync(0);
        expect(groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)).toBe(recovered);
    });

    it('does not restore presence removed between recovery and renewal', async () => {
        const server = new HeartbeatServer();
        const joined = server.groups[0];
        server.readGroups = () => {
            server.groups = [];
            return Response.json([joined]);
        };
        server.install();
        await initHeartbeat(client, { authSession: session, scope });
        await deliverDelayedFirstHeartbeat();
        expect(server.requests.filter((request) => request.path.includes('/groups/private-room/sessions/')))
            .toHaveLength(1);
        expect(groupSnapshots.findGroupStateSnapshotByRef(joined.group)).toBeUndefined();
    });

    it('stops and invalidates authentication on a recovery 401', async () => {
        const server = new HeartbeatServer();
        server.readGroups = () => new Response('Unauthorized', { status: 401 });
        server.install();
        let invalidated = false;
        await initHeartbeat(client, {
            authSession: session,
            scope,
            onAuthInvalid: () => {
                invalidated = true;
            }
        });
        await deliverDelayedFirstHeartbeat();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(invalidated).toBe(true);
        expect(server.requests).toHaveLength(1);
        expect(groupSnapshots.getAllGroupStateSnapshots()).toEqual([]);
    });

    it.each(['applicationId', 'workspaceId'] as const)('rejects a recovery response outside the captured %s', async (field) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new HeartbeatServer();
        server.groups = [createGroupSnapshotFixture({
            ...scope,
            [field]: 'another',
            groupId: 'private-room',
            sessionIds: ['alice']
        })];
        server.install();
        await initHeartbeat(client, { authSession: session, scope });
        await deliverDelayedFirstHeartbeat();
        expect(server.requests).toEqual([{ method: 'GET', path: groupsPath, authorization: 'Bearer test-token' }]);
        expect(groupSnapshots.getAllGroupStateSnapshots()).toEqual([]);
    });
});

function joinedRoom(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...scope, groupId: 'private-room', sessionIds: ['alice'] });
    return {
        ...snapshot,
        group: { ...snapshot.group, joinMode: 'invite-only' },
        activeSessions: snapshot.activeSessions.map((presence) => ({
            ...presence,
            connectedAtEpochMs: START,
            lastHeartbeatAtEpochMs: START,
            expiresAtEpochMs: START + 120_000
        }))
    };
}

async function deliverDelayedFirstHeartbeat(): Promise<void> {
    vi.setSystemTime(START + 65_000);
    await vi.advanceTimersByTimeAsync(50_000);
}
