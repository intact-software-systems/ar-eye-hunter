import { describe, expect, it } from 'vitest';

import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtAppendRejectionCode,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import {
  DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS,
  RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS,
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AppCrdtInboxService } from '@shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import { computeCrdtMutation } from '@shared-server/rallar-system/crdt/mutation/compute-crdt-mutation.ts';
import { appendRejectionReason } from '@shared-server/rallar-system/crdt/mutation/crdt-append-rejection.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'principal',
  documentType: 'checklist',
  documentId: 'document-1',
  principalId: 'alice',
};

describe('CRDT append and administration result invariants', () => {
  it('keeps semantic append identity stable while delivery identity and ' + 'retry lifetime vary', async () => {
    const capturedAtEpochMs = 1_000;
    const service = appCrdt();
    const command = await service.createAndEnqueueAppend({
      update: update('semantic-update'),
      deliveryId: 'transport-delivery-1',
      actor: actor(),
      responseAudience: audience('principal'),
      capturedAtEpochMs,
      expireAtEpochMs: capturedAtEpochMs + 60_000,
    });

    expect(command.commandId).toBe('semantic-update');
    expect(command).toMatchObject({ deliveryId: 'transport-delivery-1' });
    expect(command.expireAtEpochMs).toBe(
      capturedAtEpochMs + DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS + RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS,
    );
  });

  it('allows replay only for append producers', async () => {
    const command = await lifecycleCommand();
    const computed = computeCrdtMutation({ command, read: existingRead(), serviceId: 'server-1' });
    expect(computed.outcome).toBe('write');

    expect(() =>
      decodeCrdtMutationResult({
        ...computed.result,
        status: 'replay',
      }),
    ).toThrow(/replay|operation|status/i);
  });

  it('requires exact producer update and rejection reason relationships', async () => {
    const command = await appendCommand();
    const rejected = computeCrdtMutation({
      command,
      read: {
        ...emptyRead(),
        authorized: false,
        authorizationCode: 'authorization-scope-denied',
      },
      serviceId: 'server-1',
    });
    expect(rejected.outcome).toBe('rejected');
    if (rejected.result.operation !== 'append') {
      throw new Error(`Expected append result, received ${rejected.result.operation}`);
    }
    const appendResult = rejected.result.appendResult;

    const { update: _update, ...missingUpdate } = appendResult;
    expect(() =>
      decodeCrdtMutationResult({
        ...rejected.result,
        appendResult: missingUpdate,
      }),
    ).toThrow(/update|producer|rejection/i);
    expect(() =>
      decodeCrdtMutationResult({
        ...rejected.result,
        appendResult: { ...appendResult, reason: 'forged reason' },
      }),
    ).toThrow(/reason|rejection/i);
  });

  it('produces and decodes retryability exactly for every append rejection code', async () => {
    const command = await appendCommand();
    const producerCases = [
      {
        read: {
          ...emptyRead(),
          authorized: false,
          authorizationCode: 'authorization-scope-denied',
        },
        code: 'authorization-denied',
        retryable: false,
      },
      {
        read: {
          ...existingRead(),
          document: { ...metadata(), quota: { maxUpdateCount: 2 } },
        },
        code: 'quota-exceeded',
        retryable: false,
      },
      {
        read: {
          ...existingRead(),
          document: { ...metadata(), quota: { maxUpdatesPerMinutePerActor: 1 } },
          actorUpdatesInWindow: 1,
        },
        code: 'rate-limited',
        retryable: true,
      },
    ] as const;
    for (const expected of producerCases) {
      const computed = computeCrdtMutation({
        command,
        read: expected.read,
        serviceId: 'server-1',
      });
      if (computed.result.operation !== 'append') {
        throw new Error(`Expected append result, received ${computed.result.operation}`);
      }
      expect(computed.result.appendResult).toMatchObject({
        code: expected.code,
        retryable: expected.retryable,
      });
      expect(() => decodeCrdtMutationResult(computed.result)).not.toThrow();
    }

    const rejected = computeCrdtMutation({
      command,
      read: {
        ...emptyRead(),
        authorized: false,
        authorizationCode: 'authorization-denied',
      },
      serviceId: 'server-1',
    });
    if (rejected.result.operation !== 'append') {
      throw new Error(`Expected append result, received ${rejected.result.operation}`);
    }
    const appendResult = rejected.result.appendResult;
    for (const code of appendRejectionCodes()) {
      const retryable = code === 'storage-failed' || code === 'rate-limited';
      expect(() =>
        decodeCrdtMutationResult({
          ...rejected.result,
          code,
          appendResult: {
            ...appendResult,
            code,
            reason: appendRejectionReason(code),
            retryable: !retryable,
          },
        }),
      ).toThrow(/retryable|rejection/i);
    }
  });

  it('rejects retryability on an admin integrity result', async () => {
    const command = await rebuildCommand();
    const value = update('integrity-update');
    const rejected = computeCrdtMutation({
      command,
      read: {
        ...existingRead(),
        records: [
          {
            document: DOCUMENT,
            documentKey: toRallarCrdtDocumentKey(DOCUMENT),
            update: value,
            append: {
              appendSequence: 1,
              acceptedAtEpochMs: 1_000,
              actorId: 'client-42',
              principalId: 'alice',
              sessionId: 'session-99',
              serverId: 'server-1',
              authorizationScope: 'principal',
              acceptedUpdateHash: `${hashRallarCrdtUpdateEnvelope(value)}-corrupt`,
            },
          },
        ],
      },
      serviceId: 'server-1',
    });

    expect(rejected.result).toMatchObject({ status: 'rejected', code: 'integrity-invalid' });
    expect(() =>
      decodeCrdtMutationResult({
        ...rejected.result,
        retryable: false,
      }),
    ).toThrow(/field|key|result/i);
  });

  it('binds compact and rebuild payloads to outer metadata revision and sequence', async () => {
    for (const operation of ['compact', 'rebuild-projection'] as const) {
      const command = operation === 'compact' ? await compactCommand() : await rebuildCommand();
      const computed = computeCrdtMutation({
        command,
        read: existingRead(),
        serviceId: 'server-1',
      });
      expect(computed.outcome).toBe('write');
      const result = computed.result;

      expect(result).toHaveProperty('metadata');
      expect(() => decodeCrdtMutationResult(result)).not.toThrow();
      expect(() =>
        decodeCrdtMutationResult({
          ...result,
          documentRevision: 99,
          appendSequence: 99,
        }),
      ).toThrow(/metadata|revision|sequence/i);
    }
  });
});

function appCrdt(): AppCrdtInboxService {
  const database = createUnusedDatabase();
  const repository = {
    readMutation: () => Promise.reject(new Error('not processed')),
    writeMutation: () => Promise.reject(new Error('not processed')),
    writeOutbox: () => Promise.reject(new Error('not processed')),
  };
  return new AppCrdtInboxService(
    {
      inboxQueueReader: new InboxQueueReader(new InMemoryQueueBox()),
      resourceInboxRepository: new ResourceInboxRepository(database),
      resourceInboxResultsRepository: new ResourceInboxResultsRepository(database),
      database,
      mutationService: createCrdtMutationService({
        repository,
        createWriter: () => repository,
        serviceId: 'server-1',
      }),
      readCurrentSession: () => Promise.reject(new Error('not read')),
      wakeQueueEngine: () => undefined,
    },
    { serviceId: 'server-1', timing: undefined, appInbox: {} },
  );
}

function createUnusedDatabase(): PSqlSql {
  const database: PSqlSql = Object.assign(
    <T>(_stringsOrValues: TemplateStringsArray | readonly unknown[], ..._values: unknown[]): Promise<T> =>
      Promise.reject(new Error('Unexpected SQL execution in mutation invariant test')),
    {
      begin: <T>(_run: (sql: PSqlTransactionSql) => Promise<T>): Promise<T> =>
        Promise.reject(new Error('Unexpected transaction in mutation invariant test')),
    },
  );
  return database;
}

function actor() {
  return {
    actorId: 'client-42',
    principalId: 'alice',
    sessionId: 'session-99',
    serverId: 'server-1',
  };
}

function audience(kind: 'principal' | 'admin') {
  return {
    kind,
    senderSessionId: 'session-99',
    topicId: kind === 'admin' ? 'crdt.admin' : 'crdt.app',
    contextId: kind === 'admin' ? toRallarCrdtDocumentKey(DOCUMENT) : 'alice',
  } as const;
}

function common(commandId: string) {
  return {
    commandId,
    actor: actor(),
    capturedAtEpochMs: 2_000,
    expireAtEpochMs: 500_000,
    document: DOCUMENT,
    responseAudience: audience('admin'),
  };
}

async function appendCommand() {
  return await createCrdtMutationCommand({
    ...common('append-1'),
    operation: 'append',
    responseAudience: audience('principal'),
    authorizationScope: 'principal',
    update: update('append-1'),
  });
}

async function lifecycleCommand() {
  return await createCrdtMutationCommand({
    ...common('lifecycle-1'),
    operation: 'lifecycle',
    lifecycle: 'active',
    retentionAction: { kind: 'preserve' },
    quotaAction: { kind: 'preserve' },
    projectionIdsAction: { kind: 'preserve' },
  });
}

async function compactCommand() {
  return await createCrdtMutationCommand({
    ...common('compact-1'),
    operation: 'compact',
    snapshotId: 'snapshot-1',
    snapshot: null,
    reason: 'test',
  });
}

async function rebuildCommand() {
  return await createCrdtMutationCommand({
    ...common('rebuild-1'),
    operation: 'rebuild-projection',
    projectionId: 'default',
  });
}

function update(updateId: string): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    updateId,
    replicaId: 'replica-1',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs: 1_000,
    payload: {
      kind: 'batch',
      operations: [
        {
          kind: 'register.set',
          path: ['title'],
          policy: 'lww',
          value: updateId,
        },
      ],
    },
  };
}

function metadata(): RallarCrdtDocumentMetadata {
  return {
    document: DOCUMENT,
    documentKey: toRallarCrdtDocumentKey(DOCUMENT),
    documentRevision: 3,
    lifecycle: 'active',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 2_000,
    archivedAtEpochMs: null,
    destroyedAtEpochMs: null,
    lastAppendSequence: 2,
    updateCount: 2,
    snapshotCount: 0,
    storedUpdateBytes: 0,
    retention: null,
    quota: null,
    projectionIds: [],
  };
}

function emptyRead() {
  return {
    document: null,
    existingUpdate: null,
    existingAppend: null,
    records: [],
    snapshot: null,
    authorized: true,
    authorizationCode: 'allowed',
    featureDecision: {
      allowed: true,
      code: 'allowed' as const,
      reason: 'enabled',
      rollout: 'production' as const,
      retryable: false,
    },
    actorUpdatesInWindow: 0,
    storedSnapshotBytes: 0,
  };
}

function existingRead() {
  return { ...emptyRead(), document: metadata() };
}

function appendRejectionCodes(): readonly RallarCrdtAppendRejectionCode[] {
  return [
    'authorization-denied',
    'document-archived',
    'document-destroyed',
    'document-quarantined',
    'duplicate-hash-mismatch',
    'feature-disabled',
    'invalid-update',
    'quota-exceeded',
    'rate-limited',
    'schema-version-not-allowed',
    'update-too-large',
    'storage-failed',
  ];
}
