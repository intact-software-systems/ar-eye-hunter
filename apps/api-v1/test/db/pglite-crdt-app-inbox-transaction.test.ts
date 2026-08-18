import assert from 'node:assert/strict';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtOperationBatch,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { PSqlCrdtMutationRepository } from '@shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/services/crdt-mutations.ts';
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

Deno.test('CRDT mutation CAS commits state and logical WS outbox atomically', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtMutationRepository(sql, () => Promise.resolve(true));
    const service = createCrdtMutationService({
      repository,
      createWriter: (transaction) =>
        new PSqlCrdtMutationRepository(
          transaction,
          () => Promise.resolve(true),
        ),
      serviceId: 'server-1',
    });
    const first = await command('command-1', 'update-1', 1_000);
    await apply(sql, service, first);

    const [document] = await sql<{
      document_revision: string;
      update_count: string;
    }[]>`
      select document_revision, update_count from crdt_documents
      where document_key = ${first.documentKey}
    `;
    const outbox = await sql<{ ri_type_id: string }[]>`
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
    const secondComputed = service.compute(second, secondRead);
    const thirdComputed = service.compute(third, thirdRead);
    service.validate(second, secondRead, secondComputed);
    service.validate(third, thirdRead, thirdComputed);
    await sql.begin(async (transaction) => await service.write(transaction, secondComputed));
    await assert.rejects(
      sql.begin(async (transaction) => await service.write(transaction, thirdComputed)),
      CrdtMutationConflictError,
    );
  });
});

Deno.test('CRDT mutation rolls metadata and update back when outbox write fails', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtMutationRepository(sql, () => Promise.resolve(true));
    const failingService = createCrdtMutationService({
      repository,
      createWriter: (transaction): CrdtMutationRepository => {
        const writer = new PSqlCrdtMutationRepository(
          transaction,
          () => Promise.resolve(true),
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
    const computed = failingService.compute(input, read);
    await assert.rejects(
      sql.begin(async (transaction) => await failingService.write(transaction, computed)),
      /injected outbox failure/,
    );
    assert.equal(
      Number(
        (await sql<{ count: string }[]>`
      select count(*) as count from crdt_documents
    `)[0]?.count,
      ),
      0,
    );
    assert.equal(
      Number(
        (await sql<{ count: string }[]>`
      select count(*) as count from crdt_updates
    `)[0]?.count,
      ),
      0,
    );
  });
});

async function apply(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  service: ReturnType<typeof createCrdtMutationService>,
  input: CrdtMutationCommand,
): Promise<void> {
  const read = await service.read(input);
  const computed = service.compute(input, read);
  service.validate(input, read, computed);
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
