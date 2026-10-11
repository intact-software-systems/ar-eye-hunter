import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { PSqlResourceInboxEntryReader } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-reader.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { decodePersistedAppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure-decoding.ts';
import { toPhysicalAppInboxQueueKey } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { encodeAppInboxCommand } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import {
    decodeGroupStateInboxDurableResult,
    requireGroupMutationReceipt,
    requireGroupStateWritten
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result-codec.ts';
import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeApiMutationFailure } from '@shared/api/mutation/api-mutation-failure.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import defaults from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import type { GroupStateRouteCommandInput } from '../../src/group-state/group-state-route-contracts.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';
import { stopNativeAdmissionTestRuntime } from './native-admission-test-cleanup.ts';

const PRINCIPAL_REF = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    principalId: 'alice'
};

interface NativeGroupRequest {
    readonly baseUrl: string;
    readonly path: string;
    readonly method: 'POST' | 'PUT';
    readonly command: Extract<
        GroupStateRouteCommandInput,
        { operation: 'create-group' | 'join-group' | 'connect-group-presence'; }
    >;
}

interface NativeGroupRequestResult {
    readonly command: NativeGroupRequest['command'];
    readonly status: number;
    readonly body: JsonWireValue;
    readonly elapsedMs: number;
}

interface NativeGroupSessionFlow {
    readonly baseUrl: string;
    readonly session: IssuedAuthSession;
    readonly groupRef: GroupRef;
    readonly generationId: string;
    readonly index: number;
}

interface NativeGroupDurableResultObservation {
    readonly queueEntries: PSqlResourceInboxEntryReader;
    readonly queueResults: ResourceInboxResultsRepository;
    readonly result: NativeGroupRequestResult;
}

interface NativeGroupSessionAuthorityObservation {
    readonly baseUrl: string;
    readonly runtime: ApiV1Runtime;
    readonly groupRef: GroupRef;
    readonly sessions: readonly IssuedAuthSession[];
    readonly queueEntries: PSqlResourceInboxEntryReader;
    readonly queueResults: ResourceInboxResultsRepository;
}

Deno.test('fifteen native same-user sessions complete concurrent room setup through default automatic queues', async () => {
    const configuration = decodeApiV1Configuration({
        ...validDecodeApiV1ConfigurationInput(),
        defaultsSource: defaults
    });
    const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const backgroundProducersStopped = Promise.withResolvers<void>();
    const queueEngineStopped = Promise.withResolvers<void>();
    const queueEngineLifecycle = { started: false };
    const rallar = await createDefaultRallarServer({
        configuration,
        databaseLifecycle: {
            ...databaseLifecycle,
            close: async () => {
                backgroundProducersStopped.resolve();
                if (queueEngineLifecycle.started) {
                    await queueEngineStopped.promise;
                }
                console.log('Native admission cleanup: database close started');
                await databaseLifecycle.close();
                console.log('Native admission cleanup: database close finished');
            }
        }
    });
    const sockets: WebSocket[] = [];
    let listener: Deno.HttpServer<Deno.NetAddr> | undefined;
    let primaryFailure: Error | undefined;

    try {
        await rallar.runtime.readiness;
        const app = new Hono();
        rallar.installSystemTopics();
        rallar.installWebSocketLifecycle();
        rallar.mountWebSocket(app);
        rallar.mountRest(app);
        rallar.start();
        queueEngineLifecycle.started = true;

        const sessions = await issueSameUserSessions(rallar.runtime, configuration.authentication.sessionTtlMs);
        assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 15);
        assert.ok(sessions.every((session) => session.clientId === 'alice' && session.username === 'alice'));
        listener = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, app.fetch);
        const baseUrl = `http://127.0.0.1:${listener.addr.port}`;
        const groupRef: GroupRef = {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: `native-room-${crypto.randomUUID()}`
        };
        assert.equal(await rallar.runtime.groupsRepository.findGroup(groupRef), undefined);
        let firstFlowFailure: Error | undefined;
        const startedAt = performance.now();
        const connections = await Promise.allSettled(
            sessions.map(async (session, index) => {
                const ticket = await readWebSocketTicket(baseUrl, session, index);
                const url = new URL(`/api/ws/${session.sessionId}`, baseUrl);
                url.protocol = 'ws:';
                url.searchParams.set('ticket', ticket);
                url.searchParams.set('applicationId', 'rallar-server');
                url.searchParams.set('workspaceId', 'default');
                const socket = new WebSocket(url);
                sockets.push(socket);
                await waitForSocketOpen(socket);
                const connection = rallar.runtime.wsQBoxServerService.socket.connections.get(session.sessionId);
                assert.ok(connection?.isOpen, `Session ${index} must have its current server connection`);
                return await writeNativeGroupSessionFlow({
                    baseUrl,
                    session,
                    groupRef,
                    generationId: connection.generationId,
                    index
                });
            }).map((flow) =>
                flow.catch((cause) => {
                    firstFlowFailure ??= cause instanceof Error ? cause : new Error(String(cause));
                    throw cause;
                })
            )
        );
        if (firstFlowFailure) {
            throw firstFlowFailure;
        }
        const groupResults: NativeGroupRequestResult[] = [];
        for (const connection of connections) {
            if (connection.status === 'rejected') {
                throw connection.reason;
            }
            groupResults.push(...connection.value);
        }

        const snapshot = await readAdmittedSnapshot(rallar.runtime);
        assert.equal(sockets.length, 15);
        assert.ok(sockets.every((socket) => socket.readyState === WebSocket.OPEN));
        assert.equal(snapshot.activeSessionCount, 15);
        assert.equal(snapshot.principal.username, 'alice');
        assert.equal(snapshot.principal.status, 'active');
        assert.deepEqual(
            snapshot.activeSessions.map((session) => session.sessionId).sort(),
            sessions.map((session) => session.sessionId).sort()
        );
        const socketServer = rallar.runtime.wsQBoxServerService.socket;
        assert.equal(socketServer.connections.size, 15);
        for (const session of snapshot.activeSessions) {
            const connection = socketServer.connections.get(session.sessionId);
            assert.ok(connection?.isOpen);
            assert.equal(session.applicationId, 'rallar-server');
            assert.equal(session.workspaceId, 'default');
            assert.equal(session.principalId, 'alice');
            assert.equal(session.status, 'active');
            assert.equal(session.disconnectedAtEpochMs, null);
            assert.equal(session.transport, 'ws');
            assert.equal(session.connectionId, connection.generationId);
            assert.equal(session.generationId, connection.generationId);
            assert.ok(session.generationVersion >= 1);
            assert.ok(session.expiresAtEpochMs > Date.now());
        }
        assert.equal(
            groupResults.filter((result) => result.command.operation === 'create-group' && result.status === 201)
                .length,
            1
        );
        assert.equal(
            groupResults.filter((result) => result.command.operation === 'create-group' && result.status === 409)
                .length,
            14
        );
        assert.equal(
            groupResults.filter((result) => result.command.operation === 'join-group' && result.status === 200).length,
            15
        );
        assert.equal(
            groupResults.filter((result) =>
                result.command.operation === 'connect-group-presence' && result.status === 200
            ).length,
            15
        );
        const queueEntries = new PSqlResourceInboxEntryReader(databaseLifecycle.database, () => new Date());
        const queueResults = new ResourceInboxResultsRepository(databaseLifecycle.database);
        for (const result of groupResults) {
            await assertNativeGroupDurableResult({ queueEntries, queueResults, result });
        }
        await assertNativeGroupSessions(rallar.runtime, groupRef, sessions);
        await assertNativeGroupSessionAuthority({
            baseUrl,
            runtime: rallar.runtime,
            groupRef,
            sessions,
            queueEntries,
            queueResults
        });
        console.log(
            JSON.stringify({
                issuedSessions: 15,
                openSockets: sockets.length,
                admittedSessions: snapshot.activeSessions.length,
                roomRequests: groupResults.length,
                maxRoomRequestElapsedMs: Math.max(...groupResults.map((result) => result.elapsedMs)),
                elapsedMs: performance.now() - startedAt
            })
        );
    }
    catch (error) {
        primaryFailure = error instanceof Error ? error : new Error(String(error));
    }
    finally {
        await stopNativeAdmissionTestRuntime({
            socketClosures: sockets.map(closeSocket),
            waitForSessionDisconnects: () => waitForSessionDisconnects(rallar.runtime),
            webSocketLifecycle: rallar.runtime.wsQBoxServerService,
            listener,
            backgroundTasks: rallar.runtime.backgroundTasks,
            engine: rallar.runtime.qboxEngine,
            backgroundProducersStopped: backgroundProducersStopped.promise,
            queueEngineStopped,
            primaryFailure,
            reportProgress: console.log,
            reportSecondaryFailures: (failure) => console.error('Native admission secondary cleanup failures', failure)
        });
    }
});

async function writeNativeGroupSessionFlow(flow: NativeGroupSessionFlow): Promise<readonly NativeGroupRequestResult[]> {
    const { baseUrl, session, groupRef, generationId, index } = flow;
    const scope = { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId };
    const groupPath = `/api/state/apps/${groupRef.applicationId}/workspaces/${groupRef.workspaceId}/groups`;
    const create = await writeNativeGroupRequest({
        baseUrl,
        method: 'POST',
        path: `${groupPath}/requests/native-room-create-${index}`,
        command: {
            operation: 'create-group',
            authSession: session,
            scope,
            request: {
                requestId: `native-room-create-${index}`,
                groupId: groupRef.groupId,
                displayName: groupRef.groupId,
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice'
            }
        }
    });
    assertNativeGroupHttpResult(create);
    const join = await writeNativeGroupRequest({
        baseUrl,
        method: 'POST',
        path: `${groupPath}/${groupRef.groupId}/join/requests/native-room-join-request-${index}`,
        command: {
            operation: 'join-group',
            authSession: session,
            scope,
            groupId: groupRef.groupId,
            request: { requestId: `native-room-join-request-${index}` }
        }
    });
    assertNativeGroupHttpResult(join);
    const presence = await writeNativeGroupRequest({
        baseUrl,
        method: 'PUT',
        path: `${groupPath}/${groupRef.groupId}/sessions/${session.sessionId}/requests/native-room-presence-${index}`,
        command: {
            operation: 'connect-group-presence',
            authSession: session,
            scope,
            groupId: groupRef.groupId,
            sessionId: session.sessionId,
            request: { requestId: `native-room-presence-${index}`, principalId: 'alice', generationId }
        }
    });
    assertNativeGroupHttpResult(presence);
    return [create, join, presence];
}

async function writeNativeGroupRequest(request: NativeGroupRequest): Promise<NativeGroupRequestResult> {
    const startedAt = performance.now();
    const { requestId, ...body } = request.command.request;
    assertApiMutationRequestId(requestId);
    const response = await fetch(new URL(request.path, request.baseUrl), {
        method: request.method,
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${request.command.authSession.accessToken}`,
            'x-client-id': request.command.authSession.clientId
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000)
    }).catch((cause) => {
        throw new Error(`${requestId} failed inside its 5000 ms HTTP allowance`, { cause });
    });
    const decoded = decodeJsonWireValue(await response.json(), `HTTP response for ${requestId}`);
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 5_000, `${requestId} exceeded 5000 ms HTTP allowance`);
    console.log(JSON.stringify({ requestId, status: response.status, elapsedMs }));
    return { command: request.command, status: response.status, body: decoded, elapsedMs };
}

function assertNativeGroupHttpResult(result: NativeGroupRequestResult): void {
    const requestId = result.command.request.requestId;
    if (result.command.operation === 'create-group' && result.status === 409) {
        const failure = decodeApiMutationFailure(result.body);
        assert.ok(failure, `${requestId} must retain a canonical.v2 failure`);
        assert.equal(failure.code, 'group-already-exists', requestId);
        assert.equal(failure.status, 409, requestId);
        return;
    }
    assert.equal(
        result.status,
        result.command.operation === 'create-group' ? 201 : 200,
        `${requestId}: ${JSON.stringify(result.body)}`
    );
    validateAuthoritativeGroupSnapshot(result.body, result.command.scope);
    assert.equal(result.body.group.ownerPrincipalId, 'alice', requestId);
}

async function assertNativeGroupDurableResult(observation: NativeGroupDurableResultObservation): Promise<void> {
    const { queueEntries, queueResults, result } = observation;
    const enqueue = toGroupStateCommand(result.command);
    const key = toPhysicalAppInboxQueueKey({
        ...enqueue,
        data: encodeAppInboxCommand(enqueue.data, 'Observed group command')
    });
    const queued = await queueEntries.findAnyByKey(key);
    const durable = await queueResults.findAnyByKey(key);
    const requestId = result.command.request.requestId;
    assert.ok(queued, `${requestId} must retain its queue entry`);
    assert.ok(durable, `${requestId} must retain its durable result`);
    assert.deepEqual(queued.key, key, requestId);
    assert.deepEqual(durable.key, key, requestId);
    if (result.status === 409) {
        assert.equal(queued.status, EntityStatus.FAILED, requestId);
        assert.equal(durable.status, EntityStatus.FAILED, requestId);
        const failure = decodePersistedAppInboxFailure(durable.resource);
        assert.equal(failure.code, 'group-already-exists', requestId);
        assert.equal(failure.status, 409, requestId);
        return;
    }
    assert.equal(queued.status, EntityStatus.COMPLETED, requestId);
    assert.equal(durable.status, EntityStatus.COMPLETED, requestId);
    const decoded = decodeGroupStateInboxDurableResult(
        decodeJsonWireValue(JSON.parse(durable.resource), requestId),
        enqueue.type
    );
    if (result.command.operation === 'connect-group-presence') {
        const receipt = requireGroupMutationReceipt(decoded);
        assert.equal(receipt.requestId, requestId);
        assert.equal(receipt.outcome, 'applied', requestId);
        assert.deepEqual(receipt.aggregateRef, {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: result.command.groupId
        });
    }
    else {
        const written = requireGroupStateWritten(decoded);
        assert.equal(written.status, result.status === 201 ? 'created' : 'ok', requestId);
        assert.deepEqual(written.result.snapshot, result.body, requestId);
    }
}

async function assertNativeGroupSessions(
    runtime: ApiV1Runtime,
    groupRef: GroupRef,
    sessions: readonly AuthSession[]
): Promise<void> {
    const snapshot = await runtime.groupsRepository.readSnapshot(groupRef);
    assert.ok(snapshot, 'The unique room must exist durably');
    assert.equal(snapshot.group.ownerPrincipalId, 'alice');
    assert.equal(snapshot.group.status, 'active');
    assert.equal(snapshot.group.activeMemberCount, 1);
    assert.equal(snapshot.memberCount, 1);
    assert.deepEqual(
        snapshot.members.map((member) => ({
            principalId: member.principalId,
            role: member.role,
            status: member.status
        })),
        [
            { principalId: 'alice', role: 'owner', status: 'active' }
        ]
    );
    const presenceSessions = await runtime.groupsRepository.listPresenceSessions(groupRef);
    assert.equal(presenceSessions.length, 15);
    assert.deepEqual(
        presenceSessions.map((session) => session.sessionId).sort(),
        sessions.map((session) => session.sessionId).sort()
    );
    for (const presence of presenceSessions) {
        const connection = runtime.wsQBoxServerService.socket.connections.get(presence.sessionId);
        assert.ok(connection?.isOpen);
        assert.equal(presence.applicationId, 'rallar-server');
        assert.equal(presence.workspaceId, 'default');
        assert.equal(presence.groupId, groupRef.groupId);
        assert.equal(presence.principalId, 'alice');
        assert.equal(presence.status, 'active');
        assert.equal(presence.generationId, connection.generationId);
        assert.ok(presence.generationVersion >= 1);
        assert.equal(presence.disconnectedAtEpochMs, null);
        assert.equal(presence.disconnectReason, null);
    }
}

async function assertNativeGroupSessionAuthority(observation: NativeGroupSessionAuthorityObservation): Promise<void> {
    const { baseUrl, runtime, groupRef, sessions, queueEntries, queueResults } = observation;
    const [caller, target] = sessions;
    assert.ok(caller && target);
    const before = await runtime.groupsRepository.findPresenceSession({ ...groupRef, sessionId: target.sessionId });
    assert.ok(before);
    const requestId = 'native-room-cross-session';
    const response = await writeNativeGroupRequest({
        baseUrl,
        method: 'PUT',
        path:
            `/api/state/apps/rallar-server/workspaces/default/groups/${groupRef.groupId}/sessions/${target.sessionId}/requests/${requestId}`,
        command: {
            operation: 'connect-group-presence',
            authSession: caller,
            scope: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId },
            groupId: groupRef.groupId,
            sessionId: target.sessionId,
            request: { requestId, principalId: 'alice', generationId: `${before.generationId}-unauthorized` }
        }
    });
    assert.equal(response.status, 403);
    const failure = decodeApiMutationFailure(response.body);
    assert.ok(failure, 'Cross-session denial must retain canonical.v2');
    assert.equal(failure.code, 'authorization-denied');
    assert.equal(failure.status, 403);
    const enqueue = toGroupStateCommand(response.command);
    const key = toPhysicalAppInboxQueueKey({
        ...enqueue,
        data: encodeAppInboxCommand(enqueue.data, 'Observed unauthorized command')
    });
    assert.equal(await queueEntries.findAnyByKey(key), null, 'Unauthorized presence must not enqueue');
    assert.equal(await queueResults.findAnyByKey(key), null, 'Unauthorized presence must not create a result');
    assert.deepEqual(
        await runtime.groupsRepository.findPresenceSession({ ...groupRef, sessionId: target.sessionId }),
        before
    );
    await assertNativeGroupSessions(runtime, groupRef, sessions);
}

async function issueSameUserSessions(runtime: ApiV1Runtime, ttlMs: number): Promise<readonly IssuedAuthSession[]> {
    const sessions: IssuedAuthSession[] = [];
    for (let index = 0; index < 15; index += 1) {
        const issued = await runtime.appAuthInboxService.issueSession({
            requestId: `native-admission-session-${index}`,
            clientId: 'alice',
            username: 'alice',
            authority: { kind: 'static-client', clientId: 'alice', normalizedUsername: 'alice' },
            ttlMs
        });
        assert.ok(issued.right, 'Auth AppInbox must issue each valid session');
        const persisted = await runtime.authSessionRepository.findBySessionId(issued.right.sessionId);
        assert.ok(persisted, 'The issued session must have durable auth authority');
        assert.equal(persisted.clientId, 'alice');
        assert.equal(persisted.username, 'alice');
        sessions.push({ ...issued.right, issuedAtEpochMs: persisted.issuedAtEpochMs });
    }
    return sessions;
}

async function readWebSocketTicket(baseUrl: string, session: AuthSession, index: number): Promise<string> {
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/api/auth/ws-ticket/requests/native-admission-ticket-${index}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId },
        signal: AbortSignal.timeout(5_000)
    });
    const body: unknown = await response.json();
    assert.equal(response.status, 200, `Ticket request ${index} must succeed`);
    assert.ok(performance.now() - startedAt < 5_000, `Ticket request ${index} exceeded 5000 ms`);
    assert.ok(
        typeof body === 'object' && body !== null && 'ticket' in body && typeof body.ticket === 'string',
        'Ticket response must carry a ticket'
    );
    return body.ticket;
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            const options = { once: true, signal: controller.signal };
            socket.addEventListener('open', () => resolve(), options);
            socket.addEventListener('error', () => reject(new Error('Native WebSocket opening failed')), options);
            socket.addEventListener(
                'close',
                () => reject(new Error('Native WebSocket closed before opening')),
                options
            );
            timer = setTimeout(() => reject(new Error('Native WebSocket opening exceeded 45000 ms')), 45_000);
        });
    }
    finally {
        clearTimeout(timer);
        controller.abort();
    }
}

async function readAdmittedSnapshot(runtime: ApiV1Runtime): Promise<ClientSnapshot> {
    const deadline = performance.now() + 45_000;
    do {
        const snapshot = await runtime.clientStateService.readCurrentSnapshot(PRINCIPAL_REF);
        if (snapshot?.activeSessions.length === 15) {
            return snapshot;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    while (performance.now() < deadline);
    throw new Error('Automatic AppInbox queues did not admit all fifteen sessions within 45000 ms');
}

async function closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
        return;
    }
    const closed = new Promise<void>((resolve) => {
        socket.addEventListener('close', () => resolve(), { once: true });
    });
    socket.close();
    await closed;
}

async function waitForSessionDisconnects(runtime: ApiV1Runtime): Promise<void> {
    const deadline = performance.now() + 45_000;
    do {
        const snapshot = await runtime.clientStateService.readCurrentSnapshot(PRINCIPAL_REF);
        if (snapshot === undefined || snapshot.activeSessionCount === 0) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    while (performance.now() < deadline);
    throw new Error('Automatic AppInbox queues did not complete owned session disconnects within 45000 ms');
}
