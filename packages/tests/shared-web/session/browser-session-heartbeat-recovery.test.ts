import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { decodeJsonWireText, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { BrowserOwnWsConnectionGeneration } from '@shared-web/browser/connection/browser-own-ws-connection-generation.ts';
import { initHeartbeat, stopHeartbeat } from '@shared-web/browser/session/browser-session-heartbeat.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isApiJsonObject } from '@shared/api/api-json-value.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as groupSnapshots from '@shared/repository/group-state-snapshots-repository.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import {
    createActiveClientInstanceFixture,
    createActiveClientSessionFixture,
    createClientSnapshotFixture,
    createGroupSnapshotFixture
} from '../authoritative-group-fixtures.ts';

const serverTime = { creationEpochMs: () => Date.now(), expiryEpochMs: () => Date.now() };

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
    readonly clientHeartbeats: JsonWireValue[] = [];
    readonly groupHeartbeats: JsonWireValue[] = [];
    groups: GroupSnapshot[] = [createJoinedRoomFixture()];
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
                this.clientHeartbeats.push(decodeJsonWireText(String(init?.body)));
                return Response.json(createClientSnapshotFixture({ ...scope, principalId: 'alice' }));
            }
            const group = this.groups.find((snapshot) => path.includes(`/groups/${snapshot.group.groupId}/`));
            if (method === 'POST' && path.includes('/heartbeat/requests/') && group) {
                const request = decodeJsonWireText(String(init?.body));
                if (!isApiJsonObject(request) || typeof request.expiresAtEpochMs !== 'number') {
                    throw new Error('Expected heartbeat expiry.');
                }
                this.groupHeartbeats.push(request);
                return Response.json({
                    ...group,
                    activeSessions: group.activeSessions.map((presence) => ({
                        ...presence,
                        lastHeartbeatAtEpochMs: Date.now(),
                        expiresAtEpochMs: request.expiresAtEpochMs
                    }))
                });
            }
            return new Response('Presence not found', { status: 404 });
        });
    }
}

describe('heartbeat group recovery', () => {
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

    it('renews short group presence promptly without shortening client authentication presence', async () => {
        const server = new HeartbeatServer();
        server.install();
        groupSnapshots.setGroupStateSnapshots(server.groups);
        const handle = await initHeartbeat(client, {
            ...serverTime,
            publicationKey: null,
            authSession: session,
            scope,
            groupPresence: { leaseMs: 8_000, renewalIntervalMs: 1_000, requestTimeoutMs: 2_000, retryMs: 500 }
        });
        await vi.advanceTimersByTimeAsync(999);
        expect(server.requests).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(server.clientHeartbeats).toEqual([
            expect.objectContaining({ expiresAtEpochMs: START + 121_000 })
        ]);
        expect(server.groupHeartbeats).toEqual([
            expect.objectContaining({ expiresAtEpochMs: START + 9_000 })
        ]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(server.groupHeartbeats).toEqual([
            expect.objectContaining({ expiresAtEpochMs: START + 9_000 }),
            expect.objectContaining({ expiresAtEpochMs: START + 10_000 })
        ]);
        expect(handle.groupPresence).toEqual({ leaseMs: 8_000, renewalIntervalMs: 1_000, requestTimeoutMs: 2_000, retryMs: 500 });
    });

    it('keeps a short lease live through slow requests and one failed renewal', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new HeartbeatServer();
        server.groups = server.groups.map((group) => ({
            ...group,
            activeSessions: group.activeSessions.map((presence) => ({ ...presence, expiresAtEpochMs: START + 8_000 }))
        }));
        server.install();
        const fetchResponse = globalThis.fetch;
        let clientRequests = 0;
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
            await new Promise<void>((resolve) => setTimeout(resolve, 750));
            if (String(input).includes('/clients/alice/')) {
                clientRequests++;
                if (clientRequests === 2) {
                    return new Response('Temporary unavailability', { status: 503 });
                }
            }
            return await fetchResponse(input, init);
        });
        groupSnapshots.setGroupStateSnapshots(server.groups);
        await initHeartbeat(client, {
            ...serverTime,
            publicationKey: null,
            authSession: session,
            scope,
            groupPresence: { leaseMs: 8_000, renewalIntervalMs: 1_000, requestTimeoutMs: 2_000, retryMs: 500 }
        });
        await vi.advanceTimersByTimeAsync(2_500);
        const before = groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)?.activeSessions[0];
        expect(before?.expiresAtEpochMs).toBe(START + 9_000);
        await vi.advanceTimersByTimeAsync(3_750);
        const renewed = groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)?.activeSessions[0];
        expect(Date.now()).toBeLessThan(before!.expiresAtEpochMs);
        expect(renewed?.lastHeartbeatAtEpochMs).toBe(START + 6_250);
        expect(renewed?.expiresAtEpochMs).toBe(START + 12_750);
    });

    it('renews again after a cache observer outlives the bounded heartbeat attempt', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new HeartbeatServer();
        server.groups = server.groups.map((group) => ({
            ...group,
            activeSessions: group.activeSessions.map((presence) => ({ ...presence, expiresAtEpochMs: START + 8_000 }))
        }));
        server.install();
        groupSnapshots.setGroupStateSnapshots(server.groups);
        await groupSnapshots.waitForGroupStateSnapshotChangesIdle();
        const observer = Promise.withResolvers<void>();
        const unsubscribe = groupSnapshots.onGroupStateSnapshotChange(async (change) => {
            if (change.snapshot?.activeSessions[0]?.lastHeartbeatAtEpochMs === START + 1_000) {
                await observer.promise;
            }
        });
        try {
            await initHeartbeat(client, {
                ...serverTime,
                publicationKey: null,
                authSession: session,
                scope,
                groupPresence: { leaseMs: 8_000, renewalIntervalMs: 1_000, requestTimeoutMs: 2_000, retryMs: 500 }
            });
            await vi.advanceTimersByTimeAsync(3_500);
            expect(server.groupHeartbeats).toEqual([
                expect.objectContaining({ lastHeartbeatAtEpochMs: START + 1_000 }),
                expect.objectContaining({ lastHeartbeatAtEpochMs: START + 3_500 })
            ]);
            const renewed = groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group);
            observer.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)).toBe(renewed);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(server.groupHeartbeats.at(-1)).toMatchObject({ lastHeartbeatAtEpochMs: START + 4_500 });
        }
        finally {
            observer.resolve();
            unsubscribe();
        }
    });

    it('renews a joined private room after cache expiry while its server lease is still live', async () => {
        const server = new HeartbeatServer();
        server.install();
        groupSnapshots.setGroupStateSnapshots(server.groups);
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });

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
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
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

    it('recovers the last joined room lost to an empty observation while client heartbeats keep succeeding', async () => {
        const server = new HeartbeatServer();
        server.install();
        const joined = server.groups[0];
        groupSnapshots.setGroupStateSnapshot(joined);
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
        await vi.advanceTimersByTimeAsync(50_000);
        groupSnapshots.setGroupStateSnapshot({
            ...joined,
            group: { ...joined.group, snapshotVersion: 2, presenceVersion: 2 },
            causalRevision: { groupRevision: 2, presenceRevision: 2 },
            activeSessions: [],
            onlineMemberCount: 0
        });
        server.groups = [{
            ...joined,
            group: { ...joined.group, snapshotVersion: 3, presenceVersion: 3 },
            causalRevision: { groupRevision: 3, presenceRevision: 3 }
        }];

        await vi.advanceTimersByTimeAsync(60_000);

        expect(groupSnapshots.findGroupStateSnapshotByRef(joined.group)?.activeSessions[0])
            .toMatchObject({ sessionId: 'alice', principalId: 'alice', lastHeartbeatAtEpochMs: START + 110_000 });
        expect(server.requests.filter((request) => request.method === 'GET')).toEqual([
            { method: 'GET', path: groupsPath, authorization: 'Bearer test-token' }
        ]);
        expect(server.requests.filter((request) => request.path.startsWith(`${groupsPath}/`) && !request.path.includes('/heartbeat/requests/'))).toEqual([]);
    });

    it('rechecks empty authority at the recovery deadline without listing on every client heartbeat', async () => {
        const server = new HeartbeatServer();
        const joined = server.groups[0];
        server.groups = [];
        server.install();
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
        await vi.advanceTimersByTimeAsync(70_000);
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
        expect(groupSnapshots.getAllGroupStateSnapshots()).toEqual([]);

        server.groups = [{
            ...joined,
            activeSessions: joined.activeSessions.map((presence) => ({
                ...presence,
                lastHeartbeatAtEpochMs: Date.now(),
                expiresAtEpochMs: Date.now() + 120_000
            }))
        }];
        await vi.advanceTimersByTimeAsync(40_000);
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
        expect(groupSnapshots.getAllGroupStateSnapshots()).toEqual([]);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(groupSnapshots.findGroupStateSnapshotByRef(joined.group)?.activeSessions[0])
            .toMatchObject({ sessionId: 'alice', lastHeartbeatAtEpochMs: START + 130_000 });
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(2);
        expect(server.requests.filter((request) => request.path.startsWith(`${groupsPath}/`) && !request.path.includes('/heartbeat/requests/'))).toEqual([]);
    });

    it('recovers when awaited cache observers delay completion past the renewed snapshot TTL', async () => {
        const server = new HeartbeatServer();
        server.install();
        groupSnapshots.setGroupStateSnapshots(server.groups);
        await groupSnapshots.waitForGroupStateSnapshotChangesIdle();
        const observer = Promise.withResolvers<void>();
        const unsubscribe = groupSnapshots.onGroupStateSnapshotChange(async (change) => {
            if (change.snapshot?.activeSessions[0]?.lastHeartbeatAtEpochMs === START + 50_000) {
                await observer.promise;
            }
        });
        try {
            await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
            await vi.advanceTimersByTimeAsync(50_000);
            vi.setSystemTime(START + 115_000);
            observer.resolve();
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(20_000);
            expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
            expect(groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)?.activeSessions[0])
                .toMatchObject({ lastHeartbeatAtEpochMs: START + 135_000 });
        }
        finally {
            observer.resolve();
            unsubscribe();
        }
    });

    it('rechecks cache expiry after an in-flight socket-generation read', async () => {
        const server = new HeartbeatServer();
        server.install();
        groupSnapshots.setGroupStateSnapshots(server.groups);
        const connection = Promise.withResolvers<ReturnType<typeof createClientSnapshotFixture>>();
        const ownWsConnectionGeneration = new BrowserOwnWsConnectionGeneration({
            socket: { ws: { readyState: WebSocket.OPEN } },
            sessionId: session.sessionId,
            readOwnClientSnapshot: () => connection.promise
        });
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope, ownWsConnectionGeneration });
        await vi.advanceTimersByTimeAsync(50_000);
        vi.setSystemTime(START + 115_000);
        connection.resolve(createClientSnapshotFixture({ ...scope, principalId: 'alice' }));
        await vi.advanceTimersByTimeAsync(0);
        expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(1);
        expect(groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)?.activeSessions[0])
            .toMatchObject({ lastHeartbeatAtEpochMs: START + 115_000 });
    });

    it('bounds a stalled socket-generation read and renews presence on the next attempt', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new HeartbeatServer();
        server.install();
        groupSnapshots.setGroupStateSnapshots(server.groups);
        const stalled = Promise.withResolvers<ReturnType<typeof createClientSnapshotFixture>>();
        let lookupSignal: AbortSignal | undefined;
        let unavailable = true;
        const ownWsConnectionGeneration = new BrowserOwnWsConnectionGeneration({
            socket: { ws: { readyState: WebSocket.OPEN } },
            sessionId: session.sessionId,
            readOwnClientSnapshot: (signal) => {
                lookupSignal = signal;
                return unavailable ? stalled.promise : Promise.resolve(createSocketClientSnapshot());
            }
        });
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope, ownWsConnectionGeneration });
        await vi.advanceTimersByTimeAsync(55_000);
        expect(lookupSignal?.aborted).toBe(true);
        unavailable = false;
        await vi.advanceTimersByTimeAsync(5_000);
        const renewed = groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group);
        expect(renewed?.activeSessions[0]).toMatchObject({ lastHeartbeatAtEpochMs: START + 60_000 });
        expect(server.clientHeartbeats).toEqual([expect.objectContaining({ generationId: 'socket-alice' })]);
        stalled.resolve(createSocketClientSnapshot());
        await vi.advanceTimersByTimeAsync(0);
        expect(groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)).toBe(renewed);
        expect(server.clientHeartbeats).toHaveLength(1);
    });

    it.each(['stop', 'replace'] as const)('prevents old heartbeat effects after %s during a socket-generation lookup', async (action) => {
        const server = new HeartbeatServer();
        server.install();
        groupSnapshots.setGroupStateSnapshots(server.groups);
        const stalled = Promise.withResolvers<ReturnType<typeof createSocketClientSnapshot>>();
        const ownWsConnectionGeneration = new BrowserOwnWsConnectionGeneration({
            socket: { ws: { readyState: WebSocket.OPEN } },
            sessionId: session.sessionId,
            readOwnClientSnapshot: () => stalled.promise
        });
        const onAuthInvalid = vi.fn();
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope, ownWsConnectionGeneration, onAuthInvalid });
        await vi.advanceTimersByTimeAsync(50_000);
        if (action === 'stop') {
            stopHeartbeat();
        }
        else {
            await initHeartbeat({ clientId: 'bob', sessionId: 'bob', isOnline: true }, {
                ...serverTime,
                publicationKey: null,
                authSession: { ...session, clientId: 'bob', sessionId: 'bob', accessToken: 'replacement-token' },
                scope
            });
        }
        const observed = groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group);
        stalled.resolve(createSocketClientSnapshot());
        await vi.advanceTimersByTimeAsync(5_000);
        expect(server.requests).toEqual([]);
        expect(groupSnapshots.findGroupStateSnapshotByRef(server.groups[0].group)).toBe(observed);
        expect(onAuthInvalid).not.toHaveBeenCalled();
    });

    it.each(['removed', 'lease-expired'] as const)('does not rejoin a room whose server presence is %s', async (reason) => {
        const server = new HeartbeatServer();
        server.install();
        const joined = server.groups[0];
        groupSnapshots.setGroupStateSnapshots([joined]);
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
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
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
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
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
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
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope, ownWsConnectionGeneration });
        await deliverDelayedFirstHeartbeat();
        expect(server.requests).toHaveLength(1);
        if (action === 'stop') {
            stopHeartbeat();
        }
        else {
            await initHeartbeat({ clientId: 'bob', sessionId: 'bob', isOnline: true }, {
                ...serverTime,
                publicationKey: null,
                authSession: { ...session, clientId: 'bob', sessionId: 'bob', accessToken: 'new-token' },
                scope
            });
        }
        response.resolve(Response.json(server.groups));
        await vi.advanceTimersByTimeAsync(0);
        // The connection read ran before recovery, while this generation was still current.
        expect(connectionReads).toBe(1);
        expect(groupSnapshots.getAllGroupStateSnapshots()).toEqual([]);
        expect(server.requests).toHaveLength(1);
    });

    it('retries a failed recovery without treating it as authoritative absence', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const server = new HeartbeatServer();
        server.readGroups = () => new Response('Unavailable', { status: 503 });
        server.install();
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
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
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
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
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
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
            ...serverTime,
            publicationKey: null,
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
        await initHeartbeat(client, { ...serverTime, publicationKey: null, authSession: session, scope });
        await deliverDelayedFirstHeartbeat();
        expect(server.requests).toEqual([{ method: 'GET', path: groupsPath, authorization: 'Bearer test-token' }]);
        expect(groupSnapshots.getAllGroupStateSnapshots()).toEqual([]);
    });
});

function createSocketClientSnapshot(): ClientSnapshot {
    const identity = { ...scope, principalId: 'alice', clientInstanceId: 'alice', sessionId: 'alice' };
    return {
        ...createClientSnapshotFixture(identity),
        instances: [createActiveClientInstanceFixture(identity)],
        activeSessions: [{
            ...createActiveClientSessionFixture(identity),
            generationId: 'socket-alice',
            connectionId: 'socket-alice',
            expiresAtEpochMs: START + 120_000
        }],
        isOnline: true,
        activeSessionCount: 1
    };
}

function createJoinedRoomFixture(): GroupSnapshot {
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
