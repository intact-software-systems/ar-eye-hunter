import assert from 'node:assert/strict';

import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    type RallarCrdtDocumentRef,
    type RallarCrdtOperationBatch,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { PSqlCrdtMutationRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts';

import { createPSqlResourceInboxRepository, type PSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';

import {
    CrdtMutationConflictError,
    type CrdtMutationCommand,
    type CrdtMutationComputedWrite,
    type CrdtMutationRepository
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';

import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';

import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

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

Deno.test('CRDT mutation CAS commits state and logical WS outbox atomically', async () => {
    await verifyAtomicMutationCommit();
});

Deno.test('CRDT mutation rolls metadata and update back when outbox write fails', async () => {
    await verifyOutboxFailureRollback();
});

Deno.test(
    'CRDT mutation rejects an identical final WS outbox collision and rolls back every write',
    async () => {
        await verifyIdenticalOutboxCollisionRollback();
    }
);

async function verifyAtomicMutationCommit(): Promise<void> {
    await withPGliteSql(async (sql) => {
        const service = createMutationService(sql);
        const first = await command('command-1', 'update-1', 1_000);
        await apply(sql, service, first);
        await assertFirstMutationCommitted(sql, first.documentKey);

        const second = await command('command-2', 'update-2', 2_000);
        const third = await command('command-3', 'update-3', 3_000);
        const secondComputed = await computeValidatedWrite(service, second);
        const thirdComputed = await computeValidatedWrite(service, third);
        await sql.begin(async (transaction) => await service.write(transaction, secondComputed));
        await assert.rejects(
            sql.begin(async (transaction) => await service.write(transaction, thirdComputed)),
            CrdtMutationConflictError
        );
    });
}

async function verifyOutboxFailureRollback(): Promise<void> {
    await withPGliteSql(async (sql) => {
        const failingService = createOutboxFailureService(sql);
        const input = await command('rollback-command', 'rollback-update', 1_000);
        const computed = await computeValidatedWrite(failingService, input);
        await assert.rejects(
            sql.begin(async (transaction) => await failingService.write(transaction, computed)),
            /injected outbox failure/
        );
        await assertNoCrdtStateWrites(sql);
    });
}

async function verifyIdenticalOutboxCollisionRollback(): Promise<void> {
    await withPGliteSql(async (sql) => {
        const service = createMutationService(sql);
        const input = await command(
            'identical-outbox-collision-command',
            'identical-outbox-collision-update',
            1_000
        );
        const computed = await computeValidatedWrite(service, input);
        const entries = readCollisionEntries(computed);
        await createPSqlResourceInboxRepository(sql).entries.write(entries.collision);

        const transactionFailure = await sql.begin(
            async (transaction) => await service.write(transaction, computed)
        ).then(
            () => null,
            (error: unknown) => error
        );
        await assertOnlyCollisionRemains(sql, entries, transactionFailure);
    });
}

function createMutationRepository(sql: PGliteSql): PSqlCrdtMutationRepository {
    return new PSqlCrdtMutationRepository(
        { sql, authorize: () => Promise.resolve(true) },
        { policies: [] }
    );
}

function createMutationService(sql: PGliteSql) {
    return createCrdtMutationService({
        repository: createMutationRepository(sql),
        createWriter: (transaction) =>
            new PSqlCrdtMutationRepository(
                { sql: transaction, authorize: () => Promise.resolve(true) },
                { policies: [] }
            ),
        serviceId: 'server-1'
    });
}

function createOutboxFailureService(sql: PGliteSql) {
    return createCrdtMutationService({
        repository: createMutationRepository(sql),
        createWriter: (transaction): CrdtMutationRepository => {
            const writer = new PSqlCrdtMutationRepository(
                { sql: transaction, authorize: () => Promise.resolve(true) },
                { policies: [] }
            );
            return {
                readMutation: (command) => writer.readMutation(command),
                writeMutation: (computed) => writer.writeMutation(computed),
                writeOutbox: () => Promise.reject(new Error('injected outbox failure'))
            };
        },
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
    const durableResult = computed.outboxEntries[0];
    const collision = computed.outboxEntries.at(-1);
    assert.ok(durableResult);
    assert.ok(collision);
    assert.equal(durableResult.typeId, 'WS_OUTBOX');
    assert.equal(collision.typeId, 'WS_OUTBOX');
    assert.notDeepEqual(durableResult.key, collision.key);
    return { collision, durableResult };
}

async function assertNoCrdtStateWrites(sql: PGliteSql): Promise<void> {
    const [documents, updates] = await Promise.all([
        sql<SqlCountRow[]>`select count(*) as count from crdt_documents`,
        sql<SqlCountRow[]>`select count(*) as count from crdt_updates`
    ]);
    assert.equal(Number(documents[0]?.count), 0);
    assert.equal(Number(updates[0]?.count), 0);
}

async function assertOnlyCollisionRemains(
    sql: PGliteSql,
    entries: CollisionEntries,
    transactionFailure: unknown
): Promise<void> {
    const [documents, updates, durableResults, collisions] = await Promise.all([
        sql<SqlCountRow[]>`select count(*) as count from crdt_documents`,
        sql<SqlCountRow[]>`select count(*) as count from crdt_updates`,
        readResourceInboxCount(sql, entries.durableResult),
        readResourceInboxCount(sql, entries.collision)
    ]);
    assert.deepEqual(
        {
            transactionRejected: transactionFailure !== null,
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
        await service.write(transaction, computed);
    });
}

async function command(
    commandId: string,
    updateId: string,
    capturedAtEpochMs: number
): Promise<CrdtMutationCommand> {
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
        document: DOCUMENT,
        update: update(updateId, capturedAtEpochMs),
        authorizationScope: 'room',
        responseAudience: {
            kind: 'room',
            senderSessionId: 'session-1',
            topicId: 'room.crdt',
            contextId: 'group-1'
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
