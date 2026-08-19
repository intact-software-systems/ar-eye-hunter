import assert from 'node:assert/strict';

import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
// deno-fmt-ignore
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/\
psql-crdt-log-repository.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
// deno-fmt-ignore
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/\
ResourceInboxRepository.ts';
// deno-fmt-ignore
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/\
ResourceInboxResultsRepository.ts';
// deno-fmt-ignore
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/\
crdt-mutation-command-codec.ts';
// deno-fmt-ignore
import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/\
decode-crdt-mutation-result.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { toResilienceDto } from '../../../src/middleware-resilience.ts';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { createApiCrdtInboxService } from '../../../src/services/create-api-crdt-inbox-service.ts';
import {
  readPGliteDatabaseEpochMs,
  waitForPGliteQueueRow,
  withPGliteSql,
} from '../../db/pglite-auth-test-harness.ts';

const REASON = 'api-v1-admin-compaction';
const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'document-1',
  roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
};

interface PersistedSnapshotResultRow {
  readonly snapshot_envelope: string;
  readonly reason: string;
  readonly ris_resource: string;
}

Deno.test(
  'modern compact normalizes one reason before compute and persists it atomically',
  async () => {
    await withPGliteSql(async (sql) => {
      const now = await readPGliteDatabaseEpochMs(sql) + 12 * 60 * 60 * 1_000;
      const service = createService(sql, now);
      await service.createAndEnqueueAppend({
        update: update(now - 10_000),
        deliveryId: 'append-delivery',
        actor: actor(),
        responseAudience: audience(),
        capturedAtEpochMs: now,
        expireAtEpochMs: now + 60_000,
      });
      await drain(service, sql);
      const inputSnapshot = snapshot(now + 1);
      const command = await createCrdtMutationCommand({
        operation: 'compact',
        commandId: 'compact-command',
        actor: actor(),
        capturedAtEpochMs: now + 1,
        expireAtEpochMs: now + 60_001,
        document: DOCUMENT,
        responseAudience: audience(),
        snapshotId: inputSnapshot.snapshotId,
        snapshot: inputSnapshot,
        reason: REASON,
      });
      assert.equal(command.operation, 'compact');
      assert.equal(command.snapshot?.metadata.reason, REASON);
      const read = await service.mutationService.read(command);
      const computed = service.mutationService.compute({ command, read });

      assert.equal(computed.snapshot?.metadata.reason, REASON);
      assert.equal(computed.result.operation, 'compact');
      assert.equal(computed.result.snapshot?.metadata.reason, REASON);
      assert.deepEqual(service.mutationService.validate({ command, read, computed }), []);
      assert.deepEqual(decodeCrdtMutationResult(computed.result), computed.result);

      service.writeCrdtCommandNoWaiting(command);
      await drain(service, sql);
      const [stored] = await sql<PersistedSnapshotResultRow[]>`
      select s.snapshot_envelope, s.reason, r.ris_resource
      from crdt_snapshots s
      join resource_inbox_results r on r.ris_resource_id = 'compact-command'
    `;
      const durableResult = decodeCrdtMutationResult(JSON.parse(stored!.ris_resource));
      const persistedSnapshot = JSON.parse(stored!.snapshot_envelope) as RallarCrdtSnapshotEnvelope;

      assert.equal(stored?.reason, REASON);
      assert.equal(persistedSnapshot.metadata.reason, REASON);
      assert.equal(durableResult.operation, 'compact');
      assert.equal(durableResult.snapshot?.metadata.reason, REASON);
      assert.equal(
        (await new PSqlCrdtLogRepository(sql).readSnapshot(DOCUMENT))?.metadata.reason,
        REASON,
      );
    });
  },
);

Deno.test(
  'custom compact reason replaces snapshot input reason before command hashing',
  async () => {
    const inputSnapshot = {
      ...snapshot(2_000),
      metadata: { updateCount: 1, reason: 'stale-caller-reason' },
    };
    const command = await createCrdtMutationCommand({
      operation: 'compact',
      commandId: 'custom-reason-command',
      actor: actor(),
      capturedAtEpochMs: 2_000,
      expireAtEpochMs: 62_000,
      document: DOCUMENT,
      responseAudience: audience(),
      snapshotId: inputSnapshot.snapshotId,
      snapshot: inputSnapshot,
      reason: 'operator-approved-compaction',
    });

    assert.equal(command.operation, 'compact');
    assert.equal(command.snapshot?.metadata.reason, 'operator-approved-compaction');
    assert.equal(inputSnapshot.metadata.reason, 'stale-caller-reason');
    await assert.rejects(
      createCrdtMutationCommand({
        operation: 'compact',
        commandId: 'blank-reason-command',
        actor: actor(),
        capturedAtEpochMs: 2_000,
        expireAtEpochMs: 62_000,
        document: DOCUMENT,
        responseAudience: audience(),
        snapshotId: inputSnapshot.snapshotId,
        snapshot: inputSnapshot,
        reason: '   ',
      }),
      /reason|whitespace/i,
    );
  },
);

function createService(sql: PGliteSql, now: number) {
  const resourceInbox = new ResourceInboxRepository(sql);
  return createApiCrdtInboxService({
    inboxQueueReader: new InboxQueueReader(new PSqlQueueBox(resourceInbox)),
    resourceInboxRepository: resourceInbox,
    resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
    database: sql,
    serviceId: 'server-1',
    timing: undefined,
    options: { nowEpochMs: () => now },
    wakeQueueEngine: () => undefined,
    currentAuthority: {
      readSession: (sessionId) =>
        Promise.resolve({
          clientId: 'client-1',
          username: 'client-1',
          sessionId,
          expiresAtEpochMs: now + 60_000,
        }),
      authorizeDocument: () => Promise.resolve({ allowed: true, code: 'allowed' }),
      adminClientIds: ['client-1'],
    },
    policies: [{ documentType: 'checklist', rollout: 'production' }],
  });
}

async function drain(
  service: ReturnType<typeof createService>,
  sql: PGliteSql,
): Promise<void> {
  await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
  await service.inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
}

function actor() {
  return {
    actorId: 'client-1',
    principalId: 'client-1',
    sessionId: 'session-1',
    serverId: 'server-1',
  } as const;
}

function audience() {
  return {
    kind: 'admin',
    senderSessionId: 'session-1',
    topicId: 'crdt.admin',
    contextId: 'group-1',
  } as const;
}

function update(createdAtEpochMs: number): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    updateId: 'update-1',
    replicaId: 'replica-1',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs,
    payload: {
      kind: 'batch',
      operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: 'one' }],
    },
  };
}

function snapshot(createdAtEpochMs: number): RallarCrdtSnapshotEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    snapshotId: 'snapshot-1',
    schemaVersion: 1,
    createdAtEpochMs,
    maxLamport: 1,
    includedUpdateIds: ['update-1'],
    value: { title: 'one' },
    metadata: { updateCount: 1 },
  };
}
