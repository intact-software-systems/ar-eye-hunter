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
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeApiMutationFailure } from '@shared/api/mutation/api-mutation-failure.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import {
    closeSocket,
    createNativeSessionTestFixture,
    issueNativeWebSocketTicket,
    issueSameUserSessions,
    readAdmittedSnapshot,
    waitForSocketOpen,
    writeNativeGroupCreate,
    writeNativeGroupJoin,
    writeNativeGroupPresence,
    writeNativeGroupRequest,
    type NativeGroupRequestResult,
    type NativeGroupSessionFlow
} from './native-session-test-fixture.ts';

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
    const fixture = await createNativeSessionTestFixture();
    const sockets: WebSocket[] = [];
    let primaryFailure: Error | undefined;

    try {
        const baseUrl = await fixture.start();
        const sessions = await issueSameUserSessions(fixture.runtime, fixture.sessionTtlMs);
        assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 15);
        assert.ok(sessions.every((session) => session.clientId === 'alice' && session.username === 'alice'));
        const groupRef: GroupRef = {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: `native-room-${crypto.randomUUID()}`
        };
        assert.equal(await fixture.runtime.groupsRepository.findGroup(groupRef), undefined);
        let firstFlowFailure: Error | undefined;
        const startedAt = performance.now();
        await Promise.allSettled(
            sessions.map(async (session, index) => {
                const ticket = await issueNativeWebSocketTicket(baseUrl, session, index);
                const url = new URL(`/api/ws/${session.sessionId}`, baseUrl);
                url.protocol = 'ws:';
                url.searchParams.set('ticket', ticket);
                url.searchParams.set('applicationId', 'rallar-server');
                url.searchParams.set('workspaceId', 'default');
                const socket = new WebSocket(url);
                sockets.push(socket);
                await waitForSocketOpen(socket);
            }).map((connection) =>
                connection.catch((cause) => {
                    firstFlowFailure ??= cause instanceof Error ? cause : new Error(String(cause));
                    throw cause;
                })
            )
        );
        if (firstFlowFailure) {
            throw firstFlowFailure;
        }

        await assertNativeAdmittedSessions(fixture.runtime, sessions, sockets);
        const roomSetups = await Promise.allSettled(
            sessions.map(async (session, index) => {
                const connection = fixture.runtime.wsQBoxServerService.socket.connections.get(session.sessionId);
                assert.ok(connection?.isOpen, `Session ${index} must have its current server connection`);
                const flow: NativeGroupSessionFlow = {
                    baseUrl,
                    session,
                    groupRef,
                    generationId: connection.generationId,
                    index
                };
                const create = await writeNativeGroupCreate(flow);
                assertNativeGroupHttpResult(create);
                const join = await writeNativeGroupJoin(flow);
                assertNativeGroupHttpResult(join);
                const presence = await writeNativeGroupPresence(flow);
                assertNativeGroupHttpResult(presence);
                return [create, join, presence];
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
        for (const roomSetup of roomSetups) {
            if (roomSetup.status === 'rejected') {
                throw roomSetup.reason;
            }
            groupResults.push(...roomSetup.value);
        }

        const snapshot = await assertNativeAdmittedSessions(fixture.runtime, sessions, sockets);
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
        const queueEntries = new PSqlResourceInboxEntryReader(fixture.databaseLifecycle.database, () => new Date());
        const queueResults = new ResourceInboxResultsRepository(fixture.databaseLifecycle.database);
        for (const result of groupResults) {
            await assertNativeGroupDurableResult({ queueEntries, queueResults, result });
        }
        await assertNativeGroupSessions(fixture.runtime, groupRef, sessions);
        await assertNativeGroupSessionAuthority({
            baseUrl,
            runtime: fixture.runtime,
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
        await fixture.stop(sockets.map(closeSocket), primaryFailure);
    }
});

async function assertNativeAdmittedSessions(
    runtime: ApiV1Runtime,
    sessions: readonly IssuedAuthSession[],
    sockets: readonly WebSocket[]
): Promise<ClientSnapshot> {
    const snapshot = await readAdmittedSnapshot(runtime);
    assert.equal(sockets.length, 15);
    assert.ok(sockets.every((socket) => socket.readyState === WebSocket.OPEN));
    assert.equal(snapshot.activeSessionCount, 15);
    assert.equal(snapshot.principal.username, 'alice');
    assert.equal(snapshot.principal.status, 'active');
    assert.deepEqual(
        snapshot.activeSessions.map((session) => session.sessionId).sort(),
        sessions.map((session) => session.sessionId).sort()
    );
    const socketServer = runtime.wsQBoxServerService.socket;
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
    return snapshot;
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
        resourceId: result.command.request.requestId,
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
        resourceId: response.command.request.requestId,
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
