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
import {
    initHeartbeat,
    SESSION_HEARTBEAT_INTERVAL_MS,
    SESSION_HEARTBEAT_RENEWAL_MARGIN_MS,
    SESSION_HEARTBEAT_RETRY_MS,
    stopHeartbeat
} from '@shared-web/browser/session/browser-session-heartbeat.ts';
import { BROWSER_STATE_CACHE_TTL_MS } from '@shared-web/browser/state-cache/initialise-browser-cache-repositories.ts';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { RFC_7517_PUBLICATION_KEY } from '../../shared/api/group-presence/group-presence-publication-key-fixtures.ts';
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

interface OwnSessionLease {
    readonly lastHeartbeatAtEpochMs?: number;
    readonly expiresAtEpochMs?: number;
}

interface GroupSnapshotFixtureInput {
    readonly groupId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sessionId: string;
}

/** With a lease that outlives the browser cache, the cache TTL bounds the first renewal. */
const FIRST_RENEWAL_MS = BROWSER_STATE_CACHE_TTL_MS - SESSION_HEARTBEAT_RENEWAL_MARGIN_MS;

describe('Browser session heartbeat', () => {
    const fetchCalls: FetchCall[] = [];
    const authSession: AuthSession = {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 3_600_000
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
        stopHeartbeat();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('runs the first renewal at the browser cache TTL minus the margin when the lease outlives the cache', async () => {
        vi.useFakeTimers();
        stubFetch(({ url, method }) =>
            method === 'POST' && url.includes('/clients/principal-1/')
                ? createJsonResponse(createOwnClientSnapshot('principal-1'))
                : createTextResponse('unexpected', 500)
        );

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS - 1);
        expect(fetchCalls).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1);
        handle.stop();

        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]?.url).toContain('/sessions/session-1/heartbeat/requests/');
    });

    it('runs the first renewal at the own session lease expiry minus the margin when the lease is shorter', async () => {
        vi.useFakeTimers();
        const own = createOwnClientSnapshot('principal-1', { expiresAtEpochMs: Date.now() + 30_000 });
        clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId('principal-1', own);
        stubFetch(({ url, method }) =>
            method === 'POST' && url.includes('/clients/principal-1/')
                ? createJsonResponse(own)
                : createTextResponse('unexpected', 500)
        );

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(30_000 - SESSION_HEARTBEAT_RENEWAL_MARGIN_MS - 1);
        expect(fetchCalls).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1);
        handle.stop();

        expect(fetchCalls).toHaveLength(1);
    });

    it('skips a renewal when a connect stamped the lease inside the interval, and renews at the next interval', async () => {
        vi.useFakeTimers();
        const joined = createJoinedGroupSnapshot({
            groupId: 'live-room',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: authSession.clientId,
            sessionId: authSession.sessionId
        });
        groupStateSnapshotsRepository.setGroupStateSnapshot(joined);
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.includes('/clients/principal-1/')) {
                return createJsonResponse(createOwnClientSnapshot('principal-1', { expiresAtEpochMs: Date.now() + 3_600_000 }));
            }
            if (method === 'POST' && url.includes('/groups/live-room/')) {
                return createJsonResponse(joined);
            }
            return createTextResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(1);
        clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId('principal-1', {
            ...createOwnClientSnapshot('principal-1', {
                lastHeartbeatAtEpochMs: Date.now() + SESSION_HEARTBEAT_INTERVAL_MS - 5_000,
                expiresAtEpochMs: Date.now() + 3_600_000
            }),
            stateRevision: 2
        });

        await vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_INTERVAL_MS);
        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_INTERVAL_MS);
        handle.stop();
        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(2);
    });

    it('renews when a client-session connect stamp lies in the browser clock\'s future', async () => {
        vi.useFakeTimers();
        const joined = createJoinedGroupSnapshot({
            groupId: 'live-room',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: authSession.clientId,
            sessionId: authSession.sessionId
        });
        groupStateSnapshotsRepository.setGroupStateSnapshot(joined);
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.includes('/clients/principal-1/')) {
                return createJsonResponse(createOwnClientSnapshot('principal-1', { expiresAtEpochMs: Date.now() + 3_600_000 }));
            }
            if (method === 'POST' && url.includes('/groups/live-room/')) {
                return createJsonResponse(joined);
            }
            return createTextResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(1);
        clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId('principal-1', {
            ...createOwnClientSnapshot('principal-1', {
                lastHeartbeatAtEpochMs: Date.now() + SESSION_HEARTBEAT_INTERVAL_MS + 120_000,
                expiresAtEpochMs: Date.now() + 3_600_000
            }),
            stateRevision: 2
        });

        await vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_INTERVAL_MS);
        handle.stop();
        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(2);
    });

    it('runs the first renewal before a joined group snapshot written before the start lapses from the cache', async () => {
        vi.useFakeTimers();
        const joined = createJoinedGroupSnapshot({
            groupId: 'joined-room',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: authSession.clientId,
            sessionId: authSession.sessionId
        });
        groupStateSnapshotsRepository.setGroupStateSnapshots([joined]);
        await vi.advanceTimersByTimeAsync(15_000);
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.includes('/clients/principal-1/')) {
                return createJsonResponse(createOwnClientSnapshot('principal-1'));
            }
            if (method === 'POST' && url.includes('/groups/joined-room/')) {
                return createJsonResponse(joined);
            }
            return createTextResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(BROWSER_STATE_CACHE_TTL_MS - 15_000 - SESSION_HEARTBEAT_RENEWAL_MARGIN_MS);
        handle.stop();

        expect(fetchCalls.filter((call) => call.url.includes('/groups/joined-room/'))).toHaveLength(1);
    });

    it('registers the page\'s publication key on each renewal of a joined group\'s presence', async () => {
        vi.useFakeTimers();
        const joined = createJoinedGroupSnapshot({
            groupId: 'joined-room',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: authSession.clientId,
            sessionId: authSession.sessionId
        });
        groupStateSnapshotsRepository.setGroupStateSnapshots([joined]);
        stubFetch(({ url }) =>
            url.includes('/clients/principal-1/')
                ? createJsonResponse(createOwnClientSnapshot('principal-1'))
                : createJsonResponse(joined)
        );

        const handle = await initHeartbeat(clientData, {
            publicationKey: RFC_7517_PUBLICATION_KEY,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(BROWSER_STATE_CACHE_TTL_MS);
        handle.stop();

        const groupBodies = fetchCalls.filter((call) => call.url.includes('/groups/joined-room/')).map((call) => call.body);
        expect(groupBodies.length).toBeGreaterThan(0);
        expect(groupBodies).toEqual(groupBodies.map(() => expect.objectContaining({ publicationKey: RFC_7517_PUBLICATION_KEY })));
    });

    it('retries a failed heartbeat after the retry interval and then resumes the interval', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let remainingFailures = 1;
        stubFetch(({ method, url }) => {
            if (method === 'GET' && url.endsWith('/groups')) {
                return Response.json([]);
            }
            if (remainingFailures > 0) {
                remainingFailures -= 1;
                return createTextResponse('unavailable', 503);
            }
            return createJsonResponse(createOwnClientSnapshot('principal-1'));
        });

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_RETRY_MS - 1);
        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_INTERVAL_MS - 1);
        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        handle.stop();

        expect(fetchCalls.filter((call) => call.url.includes('/clients/principal-1/'))).toHaveLength(3);
    });

    it('uses the active scope and prunes a cached group after an authoritative heartbeat 404', async () => {
        vi.useFakeTimers();
        const staleGroup = createJoinedGroupSnapshot({
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
                return createJsonResponse(createOwnClientSnapshot('principal-1'));
            }

            if (
                method === 'POST' &&
                url.includes('/groups/stale-room/') &&
                url.includes('/sessions/session-1/heartbeat/requests/')
            ) {
                return createTextResponse('Group presence session not found: session-1', 404);
            }

            return createTextResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default'
            },
            policies: { command: { maxAttempts: 3 } }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        handle.stop();
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(fetchCalls.filter((call) => call.url.includes('/heartbeat'))).toHaveLength(2);
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
        vi.useFakeTimers();
        const observed = createJoinedGroupSnapshot({
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
                return createJsonResponse(createOwnClientSnapshot('principal-1'));
            }
            if (method === 'POST' && url.includes('/groups/stale-room/')) {
                groupStateSnapshotsRepository.setGroupStateSnapshots([newer]);
                return createTextResponse('Group presence session not found: session-1', 404);
            }
            return createTextResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        handle.stop();
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(fetchCalls.filter((call) => call.url.includes('/heartbeat'))).toHaveLength(2);
        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(observed.group)).toBe(newer);
    });

    it('keeps the joined room after the memory TTL when a heartbeat only advances session leases', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const joined = createJoinedGroupSnapshot({
            groupId: 'live-room',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: authSession.clientId,
            sessionId: authSession.sessionId
        });
        groupStateSnapshotsRepository.setGroupStateSnapshots([joined]);
        const renewed: GroupSnapshot = {
            ...joined,
            activeSessions: joined.activeSessions.map((session) => ({
                ...session,
                lastHeartbeatAtEpochMs: 1_040_000,
                expiresAtEpochMs: 1_160_000
            }))
        };
        vi.setSystemTime(1_040_000 - FIRST_RENEWAL_MS);
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.includes('/clients/principal-1/')) {
                return createJsonResponse(createOwnClientSnapshot('principal-1'));
            }
            if (method === 'POST' && url.includes('/groups/live-room/')) {
                return createJsonResponse(renewed);
            }
            return createTextResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        handle.stop();
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();
        vi.setSystemTime(1_090_000);

        expect(fetchCalls.filter((call) => call.url.includes('/heartbeat'))).toHaveLength(2);
        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(joined.group)?.activeSessions)
            .toEqual(renewed.activeSessions);
    });

    it('does not mutate client or group caches after an in-flight heartbeat is stopped', async () => {
        vi.useFakeTimers();
        const observed = createJoinedGroupSnapshot({
            groupId: 'active-room',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: authSession.clientId,
            sessionId: authSession.sessionId
        });
        const advanced: GroupSnapshot = {
            ...observed,
            group: { ...observed.group, snapshotVersion: observed.group.snapshotVersion + 1 },
            causalRevision: {
                groupRevision: observed.causalRevision.groupRevision + 1,
                presenceRevision: observed.causalRevision.presenceRevision
            }
        };
        const groupResponse = Promise.withResolvers<Response>();
        const groupRequestStarted = Promise.withResolvers<void>();
        groupStateSnapshotsRepository.setGroupStateSnapshot(observed);
        stubFetch(({ url, method }) => {
            if (method === 'POST' && url.includes('/clients/principal-1/')) {
                return createJsonResponse(createOwnClientSnapshot('principal-1'));
            }
            if (method === 'POST' && url.includes('/groups/active-room/')) {
                groupRequestStarted.resolve();
                return groupResponse.promise;
            }
            return createTextResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        await groupRequestStarted.promise;
        handle.stop();
        groupResponse.resolve(createJsonResponse(advanced));
        await vi.advanceTimersByTimeAsync(0);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(
            clientStateSnapshotsRepository.findClientStateSnapshotByPrincipalId(
                authSession.clientId
            )
        ).toBeUndefined();
        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(observed.group)).toBe(observed);
    });

    it('does not report auth invalidation from a replaced heartbeat delayed 401', async () => {
        vi.useFakeTimers();
        const firstResponse = Promise.withResolvers<Response>();
        const replacementRequestStarted = Promise.withResolvers<void>();
        const firstAuthInvalid = vi.fn();
        let isFirstRequest = true;
        stubFetch(() => {
            if (isFirstRequest) {
                isFirstRequest = false;
                return firstResponse.promise;
            }
            replacementRequestStarted.resolve();
            return createJsonResponse(createOwnClientSnapshot('principal-1'));
        });

        await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' },
            onAuthInvalid: firstAuthInvalid
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        expect(fetchCalls).toHaveLength(1);

        const replacement = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        await replacementRequestStarted.promise;
        firstResponse.resolve(createTextResponse('Unauthorized', 401));
        await vi.advanceTimersByTimeAsync(0);
        replacement.stop();

        expect(firstAuthInvalid).not.toHaveBeenCalled();
    });

    it('stops and reports auth invalidation after a single client heartbeat 401', async () => {
        vi.useFakeTimers();
        let authInvalidated = false;
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.includes('/sessions/session-1/heartbeat/requests/')
            ) {
                return createTextResponse('Unauthorized', 401);
            }

            return createTextResponse('unexpected', 500);
        });

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
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
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        handle.stop();

        expect(authInvalidated).toBe(true);
        expect(fetchCalls.map((call) => call.url)).toEqual([
            expect.stringContaining('/heartbeat')
        ]);
    });

    it('carries the generation the server issued for the session once the client snapshot holds it', async () => {
        vi.useFakeTimers();
        const own = createOwnClientSnapshot('principal-1', { expiresAtEpochMs: Date.now() + 3_600_000 });
        clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId('principal-1', own);
        stubFetch(({ url, method }) =>
            method === 'POST' && url.includes('/clients/principal-1/')
                ? createJsonResponse(own)
                : createTextResponse('unexpected', 500)
        );

        const handle = await initHeartbeat(clientData, {
            publicationKey: null,
            authSession,
            scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' }
        });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        handle.stop();

        expect(own.activeSessions[0]?.generationId).toBe('generation-session-1');
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]?.body).toMatchObject({ generationId: 'generation-session-1' });
        expect(handle.generationId).not.toBe('generation-session-1');
    });

    it('uses one generation for an active heartbeat and allocates a new one after restart', async () => {
        vi.useFakeTimers();
        stubFetch(({ url, method }) => {
            if (
                method === 'POST' &&
                url.includes('/clients/principal-1/') &&
                url.includes('/sessions/session-1/heartbeat/requests/')
            ) {
                return createJsonResponse(createOwnClientSnapshot('principal-1'));
            }

            return createTextResponse('unexpected', 500);
        });

        const first = await initHeartbeat(clientData, { publicationKey: null, authSession });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]?.body).toMatchObject({
            generationId: first.generationId
        });

        const second = await initHeartbeat(clientData, { publicationKey: null, authSession });
        await vi.advanceTimersByTimeAsync(FIRST_RENEWAL_MS);
        second.stop();
        expect(fetchCalls).toHaveLength(2);

        expect(second.generationId).not.toBe(first.generationId);
        expect(fetchCalls[1]?.body).toMatchObject({
            generationId: second.generationId
        });
    });

    function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
        vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
            const call: FetchCall = {
                url: String(input),
                method: init?.method ?? 'GET',
                body: init?.body ? decodeJsonWireText(String(init.body)) : undefined
            };
            fetchCalls.push(call);
            return handler(call);
        });
    }
});

function createJsonResponse(body: ClientSnapshot | GroupSnapshot, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

function createTextResponse(body: string, status: number): Response {
    return new Response(body, { status });
}

function hasRequestId(value: JsonWireValue | undefined): boolean {
    return typeof value === 'object' && value !== null && 'requestId' in value;
}

function createOwnClientSnapshot(principalId: string, lease: OwnSessionLease = {}): ClientSnapshot {
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
        activeSessions: [{
            ...createActiveClientSessionFixture({
                applicationId: snapshot.principal.applicationId,
                workspaceId: snapshot.principal.workspaceId,
                principalId,
                clientInstanceId: principalId,
                sessionId: 'session-1'
            }),
            ...lease
        }],
        isOnline: true,
        activeSessionCount: 1
    };
}

function createJoinedGroupSnapshot(input: GroupSnapshotFixtureInput): GroupSnapshot {
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
