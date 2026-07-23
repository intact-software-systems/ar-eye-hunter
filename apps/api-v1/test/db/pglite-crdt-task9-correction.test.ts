import assert from 'node:assert/strict';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtOperationBatch,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { PSqlCrdtLogRepository } from '@shared-server/postgres/crdt/PSqlCrdtLogRepository.ts';
import { PSqlCrdtMutationRepository } from '@shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts';
import {
  CrdtMutationConflictError,
  createCrdtMutationCommand,
  createCrdtMutationService,
  type CrdtMutationCommand,
} from '@shared-server/rallar-system/services/crdt-mutations.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1', workspaceId: 'workspace-1', scope: 'room',
  documentType: 'checklist', documentId: 'document-1',
  roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
};

Deno.test('production CRDT mutation repository denies when no current-authority reader is configured', async () => {
  await withPGliteSql(async (sql) => {
    const read = await new PSqlCrdtMutationRepository(sql).readMutation(
      await command('deny-default', 'deny-default', 1_000),
    );
    assert.equal(read.authorized, false);
  });
});

Deno.test('CRDT CAS guards revision, lifecycle, and append sequence', async () => {
  await withPGliteSql(async (sql) => {
    const service = mutationService(sql);
    await apply(sql, service, await command('first', 'first', 1_000));
    const second = await command('second', 'second', 2_000);
    const observed = await service.read(second);
    const computed = service.compute(second, observed);
    await sql`
      update crdt_documents
      set lifecycle = 'archived', last_append_sequence = 99
      where document_key = ${second.documentKey}
    `;
    await assert.rejects(
      sql.begin(async (transaction) => await service.write(transaction, computed)),
      CrdtMutationConflictError,
    );
  });
});

Deno.test('CRDT persisted row decoding fails closed on physical/logical identity corruption', async () => {
  await withPGliteSql(async (sql) => {
    const input = await command('corrupt-read', 'corrupt-read', 1_000);
    await sql`
      insert into crdt_documents (
        document_key, application_id, workspace_id, document_scope, document_type,
        document_id, document_ref, document_revision, lifecycle, created_at_ts,
        updated_at_ts, last_append_sequence, update_count, snapshot_count,
        stored_update_bytes, projection_ids
      ) values (
        ${input.documentKey}, 'wrong-app', 'workspace-1', 'room', 'checklist',
        'document-1', ${JSON.stringify({ ...DOCUMENT, applicationId: 'wrong-app' })},
        1, 'active', ${new Date(500)}, ${new Date(500)}, 0, 0, 0, 0, '[]'
      )
    `;
    await assert.rejects(
      new PSqlCrdtMutationRepository(sql, () => Promise.resolve(true)).readMutation(input),
      /document.*identity|corrupt/i,
    );
  });
});

Deno.test('CRDT read includes current actor-rate and snapshot-byte policy facts', async () => {
  await withPGliteSql(async (sql) => {
    const service = mutationService(sql);
    const first = await command('rate-first', 'rate-first', 10_000);
    await apply(sql, service, first);
    await sql`
      update crdt_documents
      set quota_policy = ${JSON.stringify({
        maxUpdatesPerMinutePerActor: 1,
        maxDocumentBytes: 10_000,
      })}
      where document_key = ${first.documentKey}
    `;
    await sql`
      insert into crdt_snapshots (
        document_key, snapshot_id, append_sequence, snapshot_envelope,
        created_at_ts, reason
      ) values (
        ${first.documentKey}, 'snapshot-policy', 1,
        ${JSON.stringify(snapshot('snapshot-policy', 'x'.repeat(2_000)))},
        ${new Date(10_000)}, 'policy-test'
      )
    `;
    const second = await command('rate-second', 'rate-second', 11_000);
    const observed = await service.read(second);
    const computed = service.compute(second, observed);
    assert.equal((observed as { actorUpdatesInWindow?: number }).actorUpdatesInWindow, 1);
    assert.ok((observed as { storedSnapshotBytes?: number }).storedSnapshotBytes! > 1_000);
    assert.deepEqual({ outcome: computed.outcome, code: 'code' in computed ? computed.code : null }, {
      outcome: 'rejected', code: 'rate-limited',
    });
  });
});

Deno.test('legacy PostgreSQL CRDT public mutators fail closed outside AppInbox orchestration', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtLogRepository(sql, { now: () => 1_000 });
    await assert.rejects(
      repository.append({
        update: update('legacy-direct', 900),
        trusted: { authorizationScope: 'room', acceptedAtEpochMs: 1_000 },
      }),
      /AppInbox|transaction-bound|disabled/i,
    );
    const [rows] = await sql<{ count: string | number }[]>`
      select count(*) as count from crdt_updates
    `;
    assert.equal(Number(rows?.count), 0);
  });
});

Deno.test('overlapping CRDT transaction writers keep one winner and no lost counter', async () => {
  await withPGliteSql(async (sql) => {
    const service = mutationService(sql);
    await apply(sql, service, await command('base', 'base', 1_000));
    const commands = await Promise.all([
      command('overlap-a', 'overlap-a', 2_000),
      command('overlap-b', 'overlap-b', 2_001),
    ]);
    const computed = await Promise.all(commands.map(async (entry) => {
      const read = await service.read(entry);
      return service.compute(entry, read);
    }));
    const writes = await Promise.allSettled(computed.map(async (entry) =>
      await sql.begin(async (transaction) => await service.write(transaction, entry))
    ));
    assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(writes.filter((result) => result.status === 'rejected').length, 1);
    const [metadata] = await sql<{ update_count: string | number; last_append_sequence: string | number }[]>`
      select update_count, last_append_sequence from crdt_documents
    `;
    assert.equal(Number(metadata?.update_count), 2);
    assert.equal(Number(metadata?.last_append_sequence), 2);
  });
});

function mutationService(sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]) {
  return createCrdtMutationService({
    repository: new PSqlCrdtMutationRepository(sql, () => Promise.resolve(true)),
    createWriter: (transaction) => new PSqlCrdtMutationRepository(
      transaction,
      () => Promise.resolve(true),
    ),
    serviceId: 'server-1',
  });
}

async function apply(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  service: ReturnType<typeof mutationService>,
  input: CrdtMutationCommand,
) {
  const read = await service.read(input);
  const computed = service.compute(input, read);
  service.validate(input, read, computed);
  await sql.begin(async (transaction) => await service.write(transaction, computed));
}

async function command(commandId: string, updateId: string, capturedAtEpochMs: number) {
  return await createCrdtMutationCommand({
    operation: 'append', commandId,
    actor: { actorId: 'actor-1', principalId: 'client-1', sessionId: 'session-1', serverId: 'server-1' },
    capturedAtEpochMs, expireAtEpochMs: capturedAtEpochMs + 60_000,
    document: DOCUMENT, update: update(updateId, capturedAtEpochMs), authorizationScope: 'room',
    responseAudience: { kind: 'room', senderSessionId: 'session-1', topicId: 'room.crdt', contextId: 'group-1' },
  });
}

function update(updateId: string, createdAtEpochMs: number): RallarCrdtUpdateEnvelope {
  const payload: RallarCrdtOperationBatch = {
    kind: 'batch',
    operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: updateId }],
  };
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION, document: DOCUMENT, updateId,
    replicaId: 'replica-1', lamport: createdAtEpochMs, parents: [], schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION, createdAtEpochMs, payload,
  };
}

function snapshot(snapshotId: string, value: unknown) {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION, document: DOCUMENT,
    snapshotId, schemaVersion: 1, createdAtEpochMs: 10_000,
    maxLamport: 0, includedUpdateIds: [], value, metadata: { updateCount: 0 },
  };
}
