import { describe, expect, it } from 'vitest';
import {
  hashRallarCrdtJson,
  hashRallarCrdtUpdateEnvelope,
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import {
  DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
  retryAfterAttempt,
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { installRallarCrdtWsTopics } from '@shared-server/crdt/RallarCrdtServer.ts';
import {
  type DocumentRow,
  toMetadata,
  toRecord,
  type UpdateRow,
} from '@shared-server/postgres/crdt/crdt-mutation-row-codec.ts';
import {
  createCrdtMutationCommand,
  decodeCrdtMutationCommand,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import { computeCrdtMutation } from '@shared-server/rallar-system/services/crdt-mutation-compute.ts';
import { toCrdtAuditOutbox } from '@shared-server/rallar-system/services/crdt-mutation-outbox.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'principal',
  documentType: 'checklist',
  documentId: 'document-1',
  principalId: 'principal-1',
};

describe('Task 9 correction 3 exact mutation contracts', () => {
  it('rejects extra fields on every command document reference', async () => {
    const command = await lifecycleCommand();
    const forged = rehash({
      ...command,
      document: { ...command.document, unexpected: true },
    });

    expect(() => decodeCrdtMutationCommand(forged)).toThrow(/document|fields|exact/i);
  });

  it('rejects non-authoritative lifecycle retention and quota set values', async () => {
    await expect(
      createCrdtMutationCommand({
        ...lifecycleInput(),
        retentionAction: {
          kind: 'set',
          value: { mode: 'retain', unexpected: true },
        },
      } as never),
    ).rejects.toThrow(/retention/i);
    await expect(
      createCrdtMutationCommand({
        ...lifecycleInput(),
        quotaAction: {
          kind: 'set',
          value: { maxDocumentBytes: -1 },
        },
      } as never),
    ).rejects.toThrow(/quota/i);
  });

  it('rejects empty or duplicate lifecycle projection IDs', async () => {
    for (const projectionIds of [[''], ['projection-1', 'projection-1']]) {
      await expect(
        createCrdtMutationCommand({
          ...lifecycleInput(),
          projectionIdsAction: { kind: 'set', value: projectionIds },
        }),
      ).rejects.toThrow(/projection/i);
    }
  });

  it('rejects persisted metadata with impossible lifecycle timestamps', () => {
    expect(() =>
      toMetadata(
        documentRow({
          lifecycle: 'archived',
          archived_at_ts: null,
        }),
        toRallarCrdtDocumentKey(DOCUMENT),
        DOCUMENT,
      ),
    ).toThrow(/metadata|lifecycle|corrupt/i);
  });

  it('rejects persisted update rows with invalid physical sequence and authorization scope', () => {
    const envelope = update();
    const row: UpdateRow = {
      document_key: toRallarCrdtDocumentKey(DOCUMENT),
      update_id: envelope.updateId,
      append_sequence: 0,
      update_envelope: JSON.stringify(envelope),
      accepted_update_hash: hashRallarCrdtUpdateEnvelope(envelope),
      actor_id: 'actor-1',
      principal_id: 'principal-1',
      session_id: 'session-1',
      server_id: 'server-1',
      authorization_scope: 'forged-scope',
      accepted_at_ts: new Date(1_000),
    };

    expect(() => toRecord(row, DOCUMENT)).toThrow(/update|sequence|scope|corrupt/i);
  });

  it('binds accepted nested results to the outer document, revision, and sequence', async () => {
    const command = await appendCommand();
    const computed = computeCrdtMutation(command, emptyRead(), 'server-1');
    expect(computed.outcome).toBe('write');
    const forged = {
      ...computed.result,
      documentKey: 'different-document-key',
      documentRevision: 99,
      appendSequence: 99,
    };

    expect(() => decodeCrdtMutationResult(forged)).toThrow(/document|revision|sequence/i);
  });

  it('computes compact output deterministically from identical command and read data', async () => {
    const command = await createCrdtMutationCommand({
      operation: 'compact',
      commandId: 'compact-1',
      actor: actor(),
      capturedAtEpochMs: 2_000,
      expireAtEpochMs: 62_000,
      document: DOCUMENT,
      responseAudience: audience(),
      snapshotId: 'compact-1-snapshot',
      snapshot: null,
      reason: 'determinism',
    });
    const read = existingRead();

    expect(computeCrdtMutation(command, read, 'server-1')).toEqual(
      computeCrdtMutation(command, read, 'server-1'),
    );
  });

  it('keeps audit work live through the complete 20-attempt retry horizon', () => {
    const capturedAtEpochMs = 1_000;
    const entry = toCrdtAuditOutbox(
      {
        kind: 'erase',
        atEpochMs: capturedAtEpochMs,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        principalId: 'principal-1',
        reason: 'privacy',
        metadata: { mode: 'destroy-document' },
      },
      {
        commandId: 'audit-1',
        capturedAtEpochMs,
        expireAtEpochMs: capturedAtEpochMs + 60_000,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
      },
      'server-1',
    );
    let finalRetryAtEpochMs = capturedAtEpochMs;
    for (let attempt = 1; attempt < DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts; attempt += 1) {
      const decision = retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, attempt, 1);
      if (decision.status === 'retry') finalRetryAtEpochMs += decision.delayMs;
    }

    expect(Number(entry.audit.expiryTs.epochMilliseconds)).toBeGreaterThanOrEqual(
      finalRetryAtEpochMs + 60_000,
    );
  });

  it('never configures update topics for live-only fanout without mutation ingress', () => {
    const definitions: Array<{ typeId: string; fanout: string }> = [];
    installRallarCrdtWsTopics({
      defineTopic: (definition) => {
        definitions.push({ typeId: definition.typeId, fanout: definition.fanout });
      },
      on: () => () => undefined,
    });

    expect(
      definitions.filter((definition) => definition.typeId === 'rallar.crdt.update.v1'),
    ).toEqual([
      { typeId: 'rallar.crdt.update.v1', fanout: 'none' },
      { typeId: 'rallar.crdt.update.v1', fanout: 'none' },
    ]);
  });
});

function actor() {
  return {
    actorId: 'actor-1',
    principalId: 'principal-1',
    sessionId: 'session-1',
    serverId: 'server-1',
  };
}

function audience() {
  return {
    kind: 'admin' as const,
    senderSessionId: 'session-1',
    topicId: 'crdt.admin',
    contextId: 'principal-1',
  };
}

function lifecycleInput() {
  return {
    operation: 'lifecycle' as const,
    commandId: 'lifecycle-1',
    actor: actor(),
    capturedAtEpochMs: 2_000,
    expireAtEpochMs: 62_000,
    document: DOCUMENT,
    responseAudience: audience(),
    lifecycle: 'active' as const,
    retentionAction: { kind: 'preserve' as const },
    quotaAction: { kind: 'preserve' as const },
    projectionIdsAction: { kind: 'preserve' as const },
  };
}

async function lifecycleCommand() {
  return await createCrdtMutationCommand(lifecycleInput());
}

async function appendCommand() {
  return await createCrdtMutationCommand({
    operation: 'append',
    commandId: 'append-1',
    actor: actor(),
    capturedAtEpochMs: 2_000,
    expireAtEpochMs: 62_000,
    document: DOCUMENT,
    responseAudience: audience(),
    authorizationScope: 'principal',
    update: update(),
  });
}

function update(): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    updateId: 'update-1',
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
          value: 'value',
        },
      ],
    },
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
  return {
    ...emptyRead(),
    document: metadata(),
  };
}

function metadata(): RallarCrdtDocumentMetadata {
  return {
    document: DOCUMENT,
    documentKey: toRallarCrdtDocumentKey(DOCUMENT),
    documentRevision: 1,
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
  };
}

function documentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  const value = metadata();
  return {
    document_key: value.documentKey,
    application_id: DOCUMENT.applicationId,
    workspace_id: DOCUMENT.workspaceId ?? null,
    document_scope: DOCUMENT.scope,
    document_type: DOCUMENT.documentType,
    document_id: DOCUMENT.documentId,
    document_ref: JSON.stringify(DOCUMENT),
    document_revision: value.documentRevision,
    lifecycle: value.lifecycle,
    created_at_ts: new Date(value.createdAtEpochMs),
    updated_at_ts: new Date(value.updatedAtEpochMs),
    archived_at_ts: null,
    destroyed_at_ts: null,
    last_append_sequence: value.lastAppendSequence,
    update_count: value.updateCount,
    snapshot_count: value.snapshotCount,
    stored_update_bytes: value.storedUpdateBytes,
    retention_policy: null,
    quota_policy: null,
    projection_ids: JSON.stringify([]),
    ...overrides,
  };
}

function rehash(value: Record<string, unknown>) {
  const { commandHash: _commandHash, ...stable } = value;
  return { ...stable, commandHash: hashRallarCrdtJson(stable) };
}
