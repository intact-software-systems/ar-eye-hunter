import { describe, expect, it } from 'vitest';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  CrdtMutationConflictError,
  type CrdtMutationComputed,
  type CrdtMutationRepository,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';

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

describe('CRDT mutation service', () => {
  it('keeps command and read provenance while writing mutation before final outbox', async () => {
    const repository = new MemoryCrdtMutationRepository();
    const service = createCrdtMutationService({
      repository,
      createWriter: () => repository,
      serviceId: 'server-1',
    });
    const command = await createAppendCommand('append-accepted', 'update-1');

    const read = await service.read(command);
    const computed = service.compute({ command, read });

    expect(computed.command).toBe(command);
    expect(computed.read).toBe(read);
    expect(service.validate({ command, read, computed })).toEqual([]);
    await expect(service.write(repository.transaction, computed)).resolves.toBe(computed.result);
    expect(repository.operations).toEqual(['write-mutation', 'write-final-outbox']);
    expect(repository.metadata?.documentRevision).toBe(1);
    expect(repository.outbox).toHaveLength(2);
  });

  it('replays an identical update and rejects an update-ID collision without writing a mutation', async () => {
    const repository = new MemoryCrdtMutationRepository();
    const service = createCrdtMutationService({
      repository,
      createWriter: () => repository,
      serviceId: 'server-1',
    });
    await applyCrdtMutation(
      service,
      repository,
      await createAppendCommand('append-first', 'update-1'),
    );

    const replay = await computeCrdtMutation(
      service,
      await createAppendCommand('append-replay', 'update-1'),
    );
    const collision = await computeCrdtMutation(
      service,
      await createAppendCommand('append-collision', 'update-1', 'different'),
    );

    expect(replay.outcome).toBe('replay');
    expect(collision).toMatchObject({
      outcome: 'rejected',
      code: 'duplicate-hash-mismatch',
    });
    expect(repository.operations).toEqual(['write-mutation', 'write-final-outbox']);
  });

  it('recomputes lifecycle and quota policy after a write conflict', async () => {
    const repository = new MemoryCrdtMutationRepository();
    const service = createCrdtMutationService({
      repository,
      createWriter: () => repository,
      serviceId: 'server-1',
    });
    const command = await createAppendCommand('append-conflict', 'update-1');
    const first = await computeCrdtMutation(service, command);
    repository.failNextConflict = true;

    await expect(service.write(repository.transaction, first)).rejects.toBeInstanceOf(
      CrdtMutationConflictError,
    );
    repository.metadata = createMetadata({
      lifecycle: 'archived',
      documentRevision: 1,
      archivedAtEpochMs: 1_000,
    });
    const retried = await computeCrdtMutation(service, command);

    expect(retried).toMatchObject({
      outcome: 'rejected',
      code: 'document-archived',
    });
    expect(repository.readCalls).toBe(2);
    expect(repository.operations).toEqual(['write-mutation']);
  });
});

async function createAppendCommand(commandId: string, updateId: string, title = 'accepted') {
  return await createCrdtMutationCommand({
    operation: 'append',
    commandId,
    actor: {
      actorId: 'actor-1',
      principalId: 'principal-1',
      sessionId: 'session-1',
      serverId: 'server-1',
    },
    capturedAtEpochMs: 1_000,
    expireAtEpochMs: 61_000,
    document: DOCUMENT,
    update: createUpdate(updateId, title),
    authorizationScope: 'room',
    responseAudience: {
      kind: 'room',
      senderSessionId: 'session-1',
      topicId: 'room.crdt',
      contextId: 'group-1',
    },
  });
}

function createUpdate(updateId: string, title: string): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    updateId,
    replicaId: 'replica-1',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs: 900,
    payload: {
      kind: 'batch',
      operations: [
        {
          kind: 'register.set',
          path: ['title'],
          policy: 'lww',
          value: title,
        },
      ],
    },
  };
}

function createMetadata(
  overrides: Partial<RallarCrdtDocumentMetadata> = {},
): RallarCrdtDocumentMetadata {
  return {
    document: DOCUMENT,
    documentKey: toRallarCrdtDocumentKey(DOCUMENT),
    documentRevision: 0,
    lifecycle: 'active',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000,
    archivedAtEpochMs: null,
    destroyedAtEpochMs: null,
    lastAppendSequence: 0,
    updateCount: 0,
    snapshotCount: 0,
    storedUpdateBytes: 0,
    retention: null,
    quota: null,
    projectionIds: [],
    ...overrides,
  };
}

class MemoryCrdtMutationRepository implements CrdtMutationRepository {
  metadata: RallarCrdtDocumentMetadata | null = null;
  updates: RallarCrdtUpdateEnvelope[] = [];
  outbox: CrdtMutationComputed['outboxEntries'][number][] = [];
  operations: string[] = [];
  readCalls = 0;
  failNextConflict = false;
  readonly transaction = {} as PSqlTransactionSql;

  readMutation() {
    this.readCalls += 1;
    return Promise.resolve({
      document: this.metadata,
      existingUpdate: this.updates.at(-1) ?? null,
      existingAppend: null,
      records: [],
      snapshot: null,
      authorized: true,
      authorizationCode: 'allowed',
      featureDecision: {
        allowed: true,
        code: 'allowed',
        reason: 'test',
        rollout: 'production',
        retryable: false,
      },
      actorUpdatesInWindow: 0,
      storedSnapshotBytes: 0,
    });
  }

  writeMutation(computed: CrdtMutationComputed) {
    this.operations.push('write-mutation');
    if (this.failNextConflict) {
      this.failNextConflict = false;
      throw new CrdtMutationConflictError(computed.documentKey);
    }
    if (computed.outcome === 'write') {
      this.metadata = computed.document;
      if (computed.operation === 'append') this.updates.push(computed.update);
    }
    return Promise.resolve();
  }

  writeOutbox(entries: CrdtMutationComputed['outboxEntries']) {
    this.operations.push('write-final-outbox');
    this.outbox.push(...entries);
    return Promise.resolve();
  }
}

async function computeCrdtMutation(
  service: ReturnType<typeof createCrdtMutationService>,
  command: Awaited<ReturnType<typeof createAppendCommand>>,
) {
  const read = await service.read(command);
  const computed = service.compute({ command, read });
  expect(service.validate({ command, read, computed })).toEqual([]);
  return computed;
}

async function applyCrdtMutation(
  service: ReturnType<typeof createCrdtMutationService>,
  repository: MemoryCrdtMutationRepository,
  command: Awaited<ReturnType<typeof createAppendCommand>>,
) {
  const computed = await computeCrdtMutation(service, command);
  return await service.write(repository.transaction, computed);
}
