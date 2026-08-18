import assert from 'node:assert/strict';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtOperationBatch,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { PSqlCrdtMutationRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';
import {
  type CrdtMutationCommand,
  CrdtMutationConflictError,
  type CrdtMutationRepository,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'document-1',
  roomRef: {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'group-1',
  },
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

Deno.test('CRDT mutation CAS commits state and logical WS outbox atomically', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtMutationRepository(
      { sql, authorize: () => Promise.resolve(true) },
      { policies: [] },
    );
    const service = createCrdtMutationService({
      repository,
      createWriter: (transaction) =>
        new PSqlCrdtMutationRepository(
          { sql: transaction, authorize: () => Promise.resolve(true) },
          { policies: [] },
        ),
      serviceId: 'server-1',
    });
    const first = await command('command-1', 'update-1', 1_000);
    await apply(sql, service, first);

    const [document] = await sql<CrdtDocumentRevisionRow[]>`
      select document_revision, update_count from crdt_documents
      where document_key = ${first.documentKey}
    `;
    const outbox = await sql<ResourceInboxTypeRow[]>`
      select ri_type_id from resource_inbox
      where ri_type_id = 'WS_OUTBOX' order by ri_resource_id
    `;
    assert.equal(Number(document?.document_revision), 1);
    assert.equal(Number(document?.update_count), 1);
    assert.deepEqual(outbox.map((row) => row.ri_type_id), ['WS_OUTBOX', 'WS_OUTBOX']);

    const second = await command('command-2', 'update-2', 2_000);
    const third = await command('command-3', 'update-3', 3_000);
    const secondRead = await service.read(second);
    const thirdRead = await service.read(third);
    const secondComputed = service.compute({ command: second, read: secondRead });
    const thirdComputed = service.compute({ command: third, read: thirdRead });
    assert.deepEqual(
      service.validate({ command: second, read: secondRead, computed: secondComputed }),
      [],
    );
    assert.deepEqual(
      service.validate({ command: third, read: thirdRead, computed: thirdComputed }),
      [],
    );
    await sql.begin(async (transaction) => await service.write(transaction, secondComputed));
    await assert.rejects(
      sql.begin(async (transaction) => await service.write(transaction, thirdComputed)),
      CrdtMutationConflictError,
    );
  });
});

Deno.test('CRDT mutation rolls metadata and update back when outbox write fails', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtMutationRepository(
      { sql, authorize: () => Promise.resolve(true) },
      { policies: [] },
    );
    const failingService = createCrdtMutationService({
      repository,
      createWriter: (transaction): CrdtMutationRepository => {
        const writer = new PSqlCrdtMutationRepository(
          { sql: transaction, authorize: () => Promise.resolve(true) },
          { policies: [] },
        );
        return {
          readMutation: (command) => writer.readMutation(command),
          writeMutation: (computed) => writer.writeMutation(computed),
          writeOutbox: () => Promise.reject(new Error('injected outbox failure')),
        };
      },
      serviceId: 'server-1',
    });
    const input = await command('rollback-command', 'rollback-update', 1_000);
    const read = await failingService.read(input);
    const computed = failingService.compute({ command: input, read });
    await assert.rejects(
      sql.begin(async (transaction) => await failingService.write(transaction, computed)),
      /injected outbox failure/,
    );
    assert.equal(
      Number(
        (await sql<SqlCountRow[]>`
      select count(*) as count from crdt_documents
    `)[0]?.count,
      ),
      0,
    );
    assert.equal(
      Number(
        (await sql<SqlCountRow[]>`
      select count(*) as count from crdt_updates
    `)[0]?.count,
      ),
      0,
    );
  });
});

Deno.test('CRDT mutation rejects an identical final WS outbox collision and rolls back every write', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtMutationRepository(
      { sql, authorize: () => Promise.resolve(true) },
      { policies: [] },
    );
    const service = createCrdtMutationService({
      repository,
      createWriter: (transaction) =>
        new PSqlCrdtMutationRepository(
          { sql: transaction, authorize: () => Promise.resolve(true) },
          { policies: [] },
        ),
      serviceId: 'server-1',
    });
    const input = await command(
      'identical-outbox-collision-command',
      'identical-outbox-collision-update',
      1_000,
    );
    const read = await service.read(input);
    const computed = service.compute({ command: input, read });
    assert.equal(computed.outcome, 'write');
    if (computed.outcome !== 'write') {
      throw new Error('Expected a CRDT write computation');
    }

    const resultEntry = computed.outboxEntries[0];
    const collisionEntry = computed.outboxEntries.at(-1);
    assert.ok(resultEntry);
    assert.ok(collisionEntry);
    assert.equal(resultEntry.typeId, 'WS_OUTBOX');
    assert.equal(collisionEntry.typeId, 'WS_OUTBOX');
    assert.notDeepEqual(resultEntry.key, collisionEntry.key);
    await new ResourceInboxRepository(sql).write(collisionEntry);

    const transactionFailure = await sql.begin(
      async (transaction) => await service.write(transaction, computed),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const [document, update, durableResult, collision] = await Promise.all([
      sql<SqlCountRow[]>`select count(*) as count from crdt_documents`,
      sql<SqlCountRow[]>`select count(*) as count from crdt_updates`,
      sql<SqlCountRow[]>`
        select count(*) as count from resource_inbox
        where ri_resource_id = ${resultEntry.key.resourceId}
          and ri_topic_id = ${resultEntry.key.topicId}
          and fk_ext_bank_id = ${resultEntry.key.contextId}
      `,
      sql<SqlCountRow[]>`
        select count(*) as count from resource_inbox
        where ri_resource_id = ${collisionEntry.key.resourceId}
          and ri_topic_id = ${collisionEntry.key.topicId}
          and fk_ext_bank_id = ${collisionEntry.key.contextId}
      `,
    ]);

    assert.deepEqual(
      {
        transactionRejected: transactionFailure !== null,
        documents: Number(document[0]?.count),
        updates: Number(update[0]?.count),
        durableResults: Number(durableResult[0]?.count),
        collisions: Number(collision[0]?.count),
      },
      {
        transactionRejected: true,
        documents: 0,
        updates: 0,
        durableResults: 0,
        collisions: 1,
      },
    );
  });
});

async function apply(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  service: ReturnType<typeof createCrdtMutationService>,
  input: CrdtMutationCommand,
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
  capturedAtEpochMs: number,
): Promise<CrdtMutationCommand> {
  return await createCrdtMutationCommand({
    operation: 'append',
    commandId,
    actor: {
      actorId: 'actor-1',
      principalId: 'principal-1',
      sessionId: 'session-1',
      serverId: 'server-1',
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
      contextId: 'group-1',
    },
  });
}

function update(updateId: string, createdAtEpochMs: number): RallarCrdtUpdateEnvelope {
  const payload: RallarCrdtOperationBatch = {
    kind: 'batch',
    operations: [{
      kind: 'register.set',
      path: ['title'],
      policy: 'lww',
      value: updateId,
    }],
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
    payload,
  };
}
