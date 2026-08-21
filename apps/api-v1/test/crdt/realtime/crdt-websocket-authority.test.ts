import assert from 'node:assert/strict';

import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import type { AuditStamp, ClientInstance, ClientPrincipal, ClientSession } from '@shared/api/client-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import {
    RALLAR_CRDT_APP_TOPIC_ID,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    RALLAR_CRDT_UPDATE_TYPE_ID,
    type RallarCrdtDocumentRef,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/mod.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { installRallarCrdtWsTopics } from '@shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts';

import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';

import { createAuthSessionRepository, createClientStateRepository } from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { RallarServerWsFacade } from '@shared-server/rallar-facade/ws-topic-router.ts';

import { createCrdtWsMutationIngress } from '@shared-server/rallar-system/crdt/inbox/create-crdt-ws-mutation-ingress.ts';

import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/\
decode-crdt-mutation-result.ts';

import { toResilienceDto } from '../../../src/middleware-resilience.ts';

import { createApiCrdtDocumentAuthorizer } from '../../../src/crdt/create-api-crdt-document-authorizer.ts';
import { createApiCrdtInboxService } from '../../../src/crdt/create-api-crdt-inbox-service.ts';
import { toPersistedAuthSessionFixture, waitForPGliteQueueRow, withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

const NOW = Date.now();
const CLIENT_ID = 'client-42';
const USERNAME = 'alice';
const SESSION_A = 'session-99';
const SESSION_B = 'session-100';

interface PersistedActorRow {
    readonly actor_id: string;
    readonly principal_id: string;
    readonly session_id: string;
}

interface CountRow {
    readonly count: string;
}

interface PersistedResultRow {
    readonly ris_resource: string;
}

interface DurableEffects {
    readonly mutations: number;
    readonly work: number;
}

interface DurableEffectsRow {
    readonly mutations: string;
    readonly work: string;
}

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    scope: 'app',
    documentType: 'checklist',
    documentId: 'document-1'
};

Deno.test(
    'browser WS ingress resolves real auth identity and rereads revoke through ' +
        'PGlite AppInbox',
    async () => {
        await withPGliteSql(async (sql) => {
            const fixture = await createFixture(sql);
            await fixture.addCurrentSession(SESSION_A);
            await fixture.addCurrentSession(SESSION_B);

            await fixture.send(
                SESSION_B,
                message(SESSION_A, 'forged-transport', update('forged-update'))
            );
            assert.deepEqual(await readDurableEffects(sql), { mutations: 0, work: 0 });

            await fixture.send(SESSION_A, message(SESSION_A, 'transport-1', update('update-1')));
            await drain(fixture.service, sql, 1);

            const [persisted] = await sql<PersistedActorRow[]>`
            select actor_id, principal_id, session_id from crdt_updates
        `;
            assert.deepEqual(persisted, {
                actor_id: CLIENT_ID,
                principal_id: USERNAME,
                session_id: SESSION_A
            });

            await fixture.send(SESSION_B, message(SESSION_B, 'transport-2', update('update-1')));
            await drain(fixture.service, sql, 2);
            const replayResults = await readResults(sql);
            assert.deepEqual(
                replayResults.map((result) => ({
                    commandId: result.commandId,
                    status: result.status
                })),
                [
                    { commandId: 'update-1', status: 'accepted' },
                    { commandId: 'update-1', status: 'replay' }
                ]
            );

            await fixture.send(SESSION_B, message(SESSION_B, 'transport-3', update('update-2')));
            await fixture.revokeAuthSession(SESSION_B);
            await drain(fixture.service, sql, 3);
            const revoked = (await readResults(sql)).at(-1);
            assert.equal(revoked?.status, 'rejected');
            assert.match(String(revoked?.code), /authentication|authorization/);
            const [count] = await sql<CountRow[]>`select count(*) as count from crdt_updates`;
            assert.equal(Number(count?.count), 1);
        });
    }
);

Deno.test('production app-scope authorization rejects a foreign application context', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createFixture(sql);
        await fixture.addCurrentSession(SESSION_A);
        const foreign = {
            ...DOCUMENT,
            applicationId: 'foreign-app',
            documentId: 'foreign-document'
        };

        await fixture.send(
            SESSION_A,
            message(SESSION_A, 'foreign-transport', update('foreign-update', foreign))
        );
        await drain(fixture.service, sql, 1);

        const [result] = await readResults(sql);
        assert.equal(result?.status, 'rejected');
        assert.match(String(result?.code), /scope|authorization/);
        const [count] = await sql<CountRow[]>`select count(*) as count from crdt_updates`;
        assert.equal(Number(count?.count), 0);
    });
});

async function createFixture(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]
) {
    const auth = createAuthSessionRepository(sql);
    const clients = createClientStateRepository(sql);
    await clients.insertPrincipal(principal());
    await clients.insertInstance(instance());
    const resourceInbox = new ResourceInboxRepository(sql);
    const service = createApiCrdtInboxService({
        inboxQueueReader: new InboxQueueReader(new PSqlQueueBox(resourceInbox)),
        resourceInboxRepository: resourceInbox,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        database: sql,
        serviceId: 'server-1',
        timing: undefined,
        options: { nowEpochMs: () => NOW },
        wakeQueueEngine: () => undefined,
        currentAuthority: {
            readSession: (sessionId) => auth.findBySessionId(sessionId),
            authorizeDocument: createApiCrdtDocumentAuthorizer({
                readGroupSnapshot: () => Promise.resolve(undefined),
                readClientSnapshot: (ref) => clients.readSnapshot(ref),
                nowEpochMs: () => NOW
            }),
            adminClientIds: []
        },
        policies: [{
            documentType: 'checklist',
            rollout: 'production',
            flags: { appScope: true }
        }]
    });
    const queue = new InMemoryQueueBox();
    const socketServer = new JsonWebSocketServer();
    const sockets = new Map<string, FakeSocket>();
    const wsService = new WsQueueBoxServerService(
        queue,
        queue,
        socketServer,
        'server-1'
    );
    const facade = new RallarServerWsFacade(wsService).install();
    installRallarCrdtWsTopics(facade, {
        mutationIngress: createCrdtWsMutationIngress(service),
        allowAppDocuments: true,
        policies: [{
            documentType: 'checklist',
            rollout: 'production',
            flags: { appScope: true }
        }]
    });
    return {
        service,
        send: async (connectionId: string, value: ReturnType<typeof message>) => {
            const socket = sockets.get(connectionId);
            assert.ok(socket);
            await socket.dispatchMessage(value);
        },
        addCurrentSession: async (sessionId: string) => {
            await auth.insertSessionBySessionId(
                await toPersistedAuthSessionFixture({
                    clientId: CLIENT_ID,
                    username: USERNAME,
                    sessionId,
                    accessToken: `${sessionId}-token`,
                    issuedAtEpochMs: NOW - 1_000,
                    expiresAtEpochMs: NOW + 600_000
                })
            );
            await clients.insertSession(clientSession(sessionId));
            const socket = new FakeSocket();
            sockets.set(sessionId, socket);
            socketServer.addConnection(new ConnectionContext(sessionId, socket));
        },
        revokeAuthSession: async (sessionId: string) => {
            const stored = await auth.findSessionBySessionIdEntry(sessionId);
            assert.ok(stored);
            await auth.deleteSessionBySessionIdIfRevision(sessionId, stored.entry.revision);
        }
    };
}

async function drain(
    service: Awaited<ReturnType<typeof createFixture>>['service'],
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
    expectedResults: number
): Promise<void> {
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await service.inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await readResults(sql)).length >= expectedResults) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Timed out waiting for CRDT AppInbox results');
}

async function readResults(sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]) {
    const rows = await sql<PersistedResultRow[]>`
        select ris_resource from resource_inbox_results
        where ris_topic_id = 'app-inbox.crdt-state'
        order by ris_row_id
    `;
    return rows.map((row) => decodeCrdtMutationResult(JSON.parse(row.ris_resource)));
}

async function readDurableEffects(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]
): Promise<DurableEffects> {
    const [row] = await sql<DurableEffectsRow[]>`
        select
          (select count(*) from crdt_updates)::text as mutations,
          (select count(*) from resource_inbox
           where ri_type_id in ('APP_INBOX', 'APP_OUTBOX', 'WS_OUTBOX'))::text as work
    `;
    return { mutations: Number(row?.mutations), work: Number(row?.work) };
}

function message(
    sessionId: string,
    msgId: string,
    envelope: RallarCrdtUpdateEnvelope
) {
    const value = newALBroadcastMessage(
        sessionId,
        newALRoute(
            RALLAR_CRDT_APP_TOPIC_ID,
            envelope.document.applicationId,
            envelope.updateId
        ),
        'all',
        RALLAR_CRDT_UPDATE_TYPE_ID,
        envelope
    );
    return { ...value, id: { ...value.id, msgId, senderId: sessionId } };
}

function update(
    updateId: string,
    document: RallarCrdtDocumentRef = DOCUMENT
): RallarCrdtUpdateEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document,
        updateId,
        replicaId: 'replica-1',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: NOW - 100,
        payload: {
            kind: 'batch',
            operations: [{
                kind: 'register.set',
                path: ['title'],
                policy: 'lww',
                value: updateId
            }]
        }
    };
}

function principal(): ClientPrincipal {
    return {
        applicationId: DOCUMENT.applicationId,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        principalId: USERNAME,
        username: USERNAME,
        displayName: 'Alice',
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        roles: [],
        metadata: {},
        status: 'active',
        disabled: null,
        deleted: null,
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit(),
        updated: audit(),
        lastSeenAtEpochMs: NOW
    };
}

function instance(): ClientInstance {
    return {
        applicationId: DOCUMENT.applicationId,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        principalId: USERNAME,
        clientInstanceId: 'browser-instance',
        status: 'active',
        revoked: null,
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        registered: audit(),
        updated: audit()
    };
}

function clientSession(sessionId: string): ClientSession {
    return {
        applicationId: DOCUMENT.applicationId,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        principalId: USERNAME,
        clientInstanceId: 'browser-instance',
        sessionId,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: sessionId,
        authenticatedAtEpochMs: NOW - 1_000,
        connectedAtEpochMs: NOW - 1_000,
        lastHeartbeatAtEpochMs: NOW,
        expiresAtEpochMs: NOW + 600_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function audit(): AuditStamp {
    return {
        atEpochMs: NOW - 1_000,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

class FakeSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = WebSocket.OPEN;
    readonly url = 'ws://test.invalid';
    binaryType: BinaryType = 'blob';
    onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;
    onerror: ((this: WebSocket, event: Event) => unknown) | null = null;
    onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
    onopen: ((this: WebSocket, event: Event) => unknown) | null = null;

    close(): void {}

    send(_data: string): void {
    }

    async dispatchMessage(value: ReturnType<typeof message>): Promise<void> {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
        await Promise.resolve();
    }
}
