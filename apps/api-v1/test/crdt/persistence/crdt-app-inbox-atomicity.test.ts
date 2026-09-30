import assert from 'node:assert/strict';
import { scheduler } from 'node:timers/promises';

import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    type RallarCrdtDocumentRef,
    type RallarCrdtOperationBatch,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import {
    computeCrdtOutboxProvenance,
    writeCrdtOutboxProvenance
} from '@shared-server/rallar-system/crdt/persistence/crdt-outbox-provenance.ts';
import {
    PSqlCrdtMutationRepository,
    writePSqlCrdtMutation
} from '@shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts';
import { WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';

import {
    CrdtMutationConflictError,
    type CrdtMutationCommand,
    type CrdtMutationComputedWrite
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';

import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';

import { TestWebSocket } from '../../../../../packages/tests/shared/websocket/test-web-socket.ts';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { withPGliteSql } from '../../db/pglite-auth-test-harness.ts';
import { authorizeTestCrdtCommand } from '../crdt-api-test-fixtures.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1'
    }
};

interface CrdtDocumentRevisionRow {
    readonly document_revision: string;
    readonly update_count: string;
}

interface ResourceInboxTypeRow {
    readonly ri_type_id: string;
}

interface SqlCountRow {
    readonly count: string;
}

interface CollisionEntries {
    readonly collision: ResourceEntry;
    readonly durableResult: ResourceEntry;
}

interface CommandInput {
    readonly commandId: string;
    readonly updateId: string;
    readonly capturedAtEpochMs: number;
    readonly document?: RallarCrdtDocumentRef;
}

interface FanoutFirstDequeueInput {
    readonly sql: PGliteSql;
    readonly entry: ResourceEntry;
    readonly scope: 'room' | 'principal' | 'app';
    readonly proofState: 'present' | 'missing';
}

Deno.test('CRDT mutation CAS commits state and logical WS outbox atomically', async () => {
    await verifyAtomicMutationCommit();
});

Deno.test('committed CRDT append reply carries scoped producer authority for dequeue', async () => {
    await withPGliteSql(async (sql) => {
        const service = createMutationService(sql);
        const input = await command({ commandId: 'scoped-reply-command', updateId: 'scoped-reply-update', capturedAtEpochMs: 1_000 });
        const computed = await computeValidatedWrite(service, input);
        const reply = computed.outboxWrites[0]?.entry;
        assert.ok(reply);
        const proofs = await computeCrdtOutboxProvenance(computed);

        await sql.begin(async (transaction) => {
            await writePSqlCrdtMutation(transaction, computed);
            await writeCrdtOutboxProvenance(transaction, proofs);
        });

        const reader = new WsOutboxProvenanceReader({
            repository: new PSqlRuntimeStateRepository(sql),
            nowMs: () => 1_001
        });
        assert.deepEqual(
            await reader.readProducerProvenance(decodePersistedALMessage(reply.resource), reply),
            {
                admittedAudience: ['session-1'],
                recipientScope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
            }
        );
    });
});

Deno.test(
    'CRDT mutation rejects an identical final WS outbox collision and rolls back every write',
    async () => {
        await verifyIdenticalOutboxCollisionRollback();
    }
);

for (const scope of ['room', 'principal', 'app'] as const) {
    for (const proofState of ['present', 'missing'] as const) {
        Deno.test(`committed CRDT ${scope} fanout first dequeue with ${proofState} producer proof`, async () => {
            await withPGliteSql(async (sql) => {
                const now = Date.now();
                const document: RallarCrdtDocumentRef = {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    scope,
                    documentType: 'checklist',
                    documentId: 'document-1',
                    ...(scope === 'room' ? { roomRef: DOCUMENT.roomRef } : {}),
                    ...(scope === 'principal' ? { principalId: 'principal-1' } : {})
                };
                const repository = new PSqlCrdtMutationRepository({
                    sql,
                    authorize: async (input) => ({
                        ...await authorizeTestCrdtCommand(input),
                        publicationAuthority: {
                            recipientScope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
                            admittedAudience: ['session-1', 'recipient', 'wrong-scope', 'wrong-principal']
                        }
                    })
                }, { policies: [] });
                const service = createCrdtMutationService({ repository, serviceId: 'producer' });
                const input = await command({ commandId: 'fanout-command', updateId: 'fanout-update', capturedAtEpochMs: now, document });
                const computed = await computeValidatedWrite(service, input);
                const proofs = await computeCrdtOutboxProvenance(computed);
                await sql.begin(async (transaction) => {
                    await writePSqlCrdtMutation(transaction, computed);
                    if (proofState === 'present') {
                        await writeCrdtOutboxProvenance(transaction, proofs);
                    }
                });
                const rows = await sql<ResourceInboxRow[]>`
                    select * from resource_inbox where ri_type_id = 'WS_OUTBOX'
                    and ri_resource::jsonb->'payload'->>'typeId' = 'rallar.crdt.update.v1'
                `;
                assert.equal(rows.length, 1);
                await assertFanoutFirstDequeue({ sql, entry: toDomain(rows[0]!), scope, proofState });
            });
        });
    }
}

async function assertFanoutFirstDequeue(input: FanoutFirstDequeueInput): Promise<void> {
    const { sql, entry, scope, proofState } = input;
    const socket = new JsonWebSocketServer();
    const recipients = ['session-1', 'recipient', 'wrong-scope', 'wrong-principal', 'late-joiner'].map((id) => {
        const native = new TestWebSocket(`ws://${id}`);
        native.open();
        socket.addConnection(new ConnectionContext({ id, socket: native }));
        return { id, native };
    });
    const reader = new WsOutboxProvenanceReader({ repository: new PSqlRuntimeStateRepository(sql), nowMs: Date.now });
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        name: 'foreign-dequeue',
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        readProducerProvenance: (message, row) => reader.readProducerProvenance(message, row),
        readAuthenticatedConnectionScope: (connection) => ({
            scope: {
                applicationId: 'app-1',
                workspaceId: connection.id === 'wrong-scope' ? 'other' : 'workspace-1'
            },
            principalId: connection.id === 'wrong-principal' ? 'other' : 'principal-1',
            expiresAtEpochMs: Date.now() + 60_000
        })
    });
    try {
        await stores.workQueue.enqueue(entry);
        await engine.executeOnce();
        // executeOnce submits tracked work; it does not await every task's completion.
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
            const status = (await stores.workQueue.getItem(entry.key))?.status;
            if (status === EntityStatus.COMPLETED || status === EntityStatus.NON_RETRYABLE) {
                break;
            }
            await scheduler.yield();
        }
        assert.equal((await stores.workQueue.getItem(entry.key))?.status, proofState === 'present' ? EntityStatus.COMPLETED : EntityStatus.NON_RETRYABLE);
        const delivered = recipients.filter(({ native }) => native.sent.length > 0).map(({ id }) => id);
        assert.deepEqual(
            delivered,
            proofState === 'missing' ? [] : scope === 'principal'
                ? ['session-1', 'recipient']
                : scope === 'room'
                ? ['recipient', 'wrong-principal']
                : ['recipient', 'wrong-principal', 'late-joiner']
        );
        for (const { native } of recipients) {
            assert.ok(native.sent.length <= 1);
            if (native.sent[0] !== undefined) {
                const sent = decodePersistedALMessage(native.sent[0]);
                assert.equal(sent.id.msgId, 'crdt:fanout-command:fanout');
                assert.equal(sent.payload.typeId, 'rallar.crdt.update.v1');
                assert.equal(JSON.parse(sent.payload.resource).updateId, 'fanout-update');
            }
        }
    }
    finally {
        service.dispose();
        engine.stop();
        for (const { native } of recipients) {
            native.close();
        }
    }
}

async function verifyAtomicMutationCommit(): Promise<void> {
    await withPGliteSql(async (sql) => {
        const service = createMutationService(sql);
        const first = await command({ commandId: 'command-1', updateId: 'update-1', capturedAtEpochMs: 1_000 });
        await apply(sql, service, first);
        await assertFirstMutationCommitted(sql, first.documentKey);

        const second = await command({ commandId: 'command-2', updateId: 'update-2', capturedAtEpochMs: 2_000 });
        const third = await command({ commandId: 'command-3', updateId: 'update-3', capturedAtEpochMs: 3_000 });
        const secondComputed = await computeValidatedWrite(service, second);
        const thirdComputed = await computeValidatedWrite(service, third);
        await sql.begin(async (transaction) => await writePSqlCrdtMutation(transaction, secondComputed));
        await assert.rejects(
            sql.begin(async (transaction) => await writePSqlCrdtMutation(transaction, thirdComputed)),
            CrdtMutationConflictError
        );
    });
}

async function verifyIdenticalOutboxCollisionRollback(): Promise<void> {
    await withPGliteSql(async (sql) => {
        const service = createMutationService(sql);
        const input = await command({
            commandId: 'identical-outbox-collision-command',
            updateId: 'identical-outbox-collision-update',
            capturedAtEpochMs: 1_000
        });
        const computed = await computeValidatedWrite(service, input);
        const entries = readCollisionEntries(computed);
        await createPSqlResourceInboxRepository(sql).entries.write(entries.collision);

        const transactionRejected = await sql.begin(
            async (transaction) => await writePSqlCrdtMutation(transaction, computed)
        ).then(
            () => false,
            () => true
        );
        await assertOnlyCollisionRemains(sql, entries, transactionRejected);
    });
}

function createMutationService(sql: PGliteSql) {
    return createCrdtMutationService({
        repository: new PSqlCrdtMutationRepository({ sql, authorize: authorizeTestCrdtCommand }, { policies: [] }),
        serviceId: 'server-1'
    });
}

async function assertFirstMutationCommitted(
    sql: PGliteSql,
    documentKey: string
): Promise<void> {
    const [document] = await sql<CrdtDocumentRevisionRow[]>`
    select document_revision, update_count from crdt_documents
    where document_key = ${documentKey}
  `;
    const outbox = await sql<ResourceInboxTypeRow[]>`
    select ri_type_id from resource_inbox
    where ri_type_id = 'WS_OUTBOX' order by ri_resource_id
  `;
    assert.equal(Number(document?.document_revision), 1);
    assert.equal(Number(document?.update_count), 1);
    assert.deepEqual(outbox.map((row) => row.ri_type_id), ['WS_OUTBOX', 'WS_OUTBOX']);
}

async function computeValidatedWrite(
    service: ReturnType<typeof createCrdtMutationService>,
    input: CrdtMutationCommand
): Promise<CrdtMutationComputedWrite> {
    const read = await service.read(input);
    const computed = service.compute({ command: input, read });
    assert.deepEqual(service.validate({ command: input, read, computed }), []);
    assert.equal(computed.outcome, 'write');
    if (computed.outcome !== 'write') {
        throw new Error('Expected a CRDT write computation');
    }
    return computed;
}

function readCollisionEntries(computed: CrdtMutationComputedWrite): CollisionEntries {
    const durableResult = computed.outboxWrites[0]?.entry;
    const collision = computed.outboxWrites.at(-1)?.entry;
    assert.ok(durableResult);
    assert.ok(collision);
    assert.equal(durableResult.typeId, 'WS_OUTBOX');
    assert.equal(collision.typeId, 'WS_OUTBOX');
    assert.notDeepEqual(durableResult.key, collision.key);
    return { collision, durableResult };
}

async function assertOnlyCollisionRemains(
    sql: PGliteSql,
    entries: CollisionEntries,
    transactionRejected: boolean
): Promise<void> {
    const [documents, updates, durableResults, collisions] = await Promise.all([
        sql<SqlCountRow[]>`select count(*) as count from crdt_documents`,
        sql<SqlCountRow[]>`select count(*) as count from crdt_updates`,
        readResourceInboxCount(sql, entries.durableResult),
        readResourceInboxCount(sql, entries.collision)
    ]);
    assert.deepEqual(
        {
            transactionRejected,
            documents: Number(documents[0]?.count),
            updates: Number(updates[0]?.count),
            durableResults,
            collisions
        },
        {
            transactionRejected: true,
            documents: 0,
            updates: 0,
            durableResults: 0,
            collisions: 1
        }
    );
}

async function readResourceInboxCount(sql: PGliteSql, entry: ResourceEntry): Promise<number> {
    const [row] = await sql<SqlCountRow[]>`
    select count(*) as count from resource_inbox
    where ri_resource_id = ${entry.key.resourceId}
      and ri_topic_id = ${entry.key.topicId}
      and fk_ext_bank_id = ${entry.key.contextId}
  `;
    return Number(row?.count);
}

async function apply(
    sql: PGliteSql,
    service: ReturnType<typeof createCrdtMutationService>,
    input: CrdtMutationCommand
): Promise<void> {
    const read = await service.read(input);
    const computed = service.compute({ command: input, read });
    assert.deepEqual(service.validate({ command: input, read, computed }), []);
    await sql.begin(async (transaction) => {
        await writePSqlCrdtMutation(transaction, computed);
    });
}

async function command(input: CommandInput): Promise<CrdtMutationCommand> {
    const { commandId, updateId, capturedAtEpochMs, document = DOCUMENT } = input;
    if (document.scope === 'custom') {
        throw new Error('This publication fixture covers room, principal and app documents');
    }
    return await createCrdtMutationCommand({
        operation: 'append',
        commandId,
        actor: {
            actorId: 'actor-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            serverId: 'server-1'
        },
        capturedAtEpochMs,
        expireAtEpochMs: capturedAtEpochMs + 60_000,
        document,
        update: { ...update(updateId, capturedAtEpochMs), document },
        authorizationScope: document.scope,
        responseAudience: {
            kind: document.scope,
            senderSessionId: 'session-1',
            topicId: `${document.scope}.crdt`,
            contextId: document.scope === 'room' ? 'group-1' : document.scope === 'principal' ? 'principal-1' : 'app-1'
        }
    });
}

function update(updateId: string, createdAtEpochMs: number): RallarCrdtUpdateEnvelope {
    const payload: RallarCrdtOperationBatch = {
        kind: 'batch',
        operations: [{
            kind: 'register.set',
            path: ['title'],
            policy: 'lww',
            value: updateId
        }]
    };
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: DOCUMENT,
        updateId,
        replicaId: 'replica-1',
        lamport: createdAtEpochMs,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs,
        payload
    };
}
