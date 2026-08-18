import { describe, expect, it } from 'vitest';
import {
  hashRallarCrdtUpdateEnvelope,
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import { computeCrdtMutation } from '@shared-server/rallar-system/crdt/mutation/compute-crdt-mutation.ts';
import { toCrdtAuditOutbox } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-outbox.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'principal',
  documentType: 'checklist',
  documentId: 'document-1',
  principalId: 'principal-1',
};

describe('CRDT mutation safety and audience invariants', () => {
  it('rejects impossible nested result/status combinations', () => {
    expect(() =>
      decodeCrdtMutationResult({
        version: 1,
        operation: 'lifecycle',
        status: 'rejected',
        commandId: 'command-1',
        documentKey: 'document-key',
        documentRevision: 1,
        appendSequence: null,
        code: 'authorization-denied',
        metadata: { lifecycle: 'active' },
      }),
    ).toThrow(/status|metadata|rejected|result/i);
  });

  it('addresses principal fanout to the principal instead of only the sender session', async () => {
    const command = await createCrdtMutationCommand({
      operation: 'append',
      commandId: 'delivery-1',
      actor: {
        actorId: 'actor-1',
        principalId: 'principal-1',
        sessionId: 'session-1',
        serverId: 'server-1',
      },
      capturedAtEpochMs: 1_000,
      expireAtEpochMs: 61_000,
      document: DOCUMENT,
      responseAudience: {
        kind: 'principal',
        senderSessionId: 'session-1',
        topicId: 'principal.crdt',
        contextId: 'principal-1',
      },
      authorizationScope: 'principal',
      update: {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: DOCUMENT,
        updateId: 'update-1',
        replicaId: 'replica-1',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 10,
        payload: {
          kind: 'batch',
          operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: 'value' }],
        },
      },
    });
    const computed = computeCrdtMutation({
      command,
      read: {
        document: null,
        existingUpdate: null,
        existingAppend: null,
        records: [],
        snapshot: null,
        authorized: true,
        authorizationCode: 'allowed',
        actorUpdatesInWindow: 0,
        storedSnapshotBytes: 0,
        featureDecision: {
          allowed: true,
          code: 'allowed',
          reason: 'enabled',
          rollout: 'production',
          retryable: false,
        },
      },
      serviceId: 'server-1',
    });
    const fanout = JSON.parse(computed.outboxEntries[1]!.resource);
    expect(fanout.targets).toEqual({
      mode: 'unicast',
      toPeerId: 'principal-1',
    });
  });

  it('rejects compaction when the retained snapshot exceeds maxDocumentBytes', async () => {
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
      reason: 'quota-test',
    });
    const computed = computeCrdtMutation({
      command,
      read: read({ quota: { maxDocumentBytes: 1 } }),
      serviceId: 'server-1',
    });
    expect(computed).toMatchObject({ outcome: 'rejected', code: 'quota-exceeded' });
  });

  it('rejects projection rebuild before write when source integrity is invalid', async () => {
    const update = updateEnvelope('gap-update');
    const command = await createCrdtMutationCommand({
      operation: 'rebuild-projection',
      commandId: 'rebuild-1',
      actor: actor(),
      capturedAtEpochMs: 2_000,
      expireAtEpochMs: 62_000,
      document: DOCUMENT,
      responseAudience: audience(),
      projectionId: 'projection-1',
    });
    const computed = computeCrdtMutation({
      command,
      read: {
        ...read(),
        records: [
          {
            document: DOCUMENT,
            documentKey: command.documentKey,
            update,
            append: {
              appendSequence: 2,
              acceptedAtEpochMs: 1_000,
              actorId: 'actor-1',
              principalId: 'principal-1',
              sessionId: 'session-1',
              serverId: 'server-1',
              authorizationScope: 'principal',
              acceptedUpdateHash: `${hashRallarCrdtUpdateEnvelope(update)}-corrupt`,
            },
          },
        ],
      },
      serviceId: 'server-1',
    });
    expect(computed).toMatchObject({ outcome: 'rejected', code: 'integrity-invalid' });
  });

  it('normalizes durable audit queue keys for long external identities', () => {
    const entry = toCrdtAuditOutbox(
      {
        kind: 'erase',
        atEpochMs: 1_000,
        documentKey: 'document-key',
        principalId: 'principal-1',
        reason: 'privacy',
        metadata: { mode: 'destroy-document' },
      },
      {
        commandId: `request-${'x'.repeat(100)}`,
        capturedAtEpochMs: 1_000,
        expireAtEpochMs: 61_000,
        documentKey: `document-${'y'.repeat(100)}`,
      },
      'server-1',
    );

    expect(entry.key.resourceId.length).toBeLessThanOrEqual(36);
    expect(entry.key.contextId.length).toBeLessThanOrEqual(35);
    expect(JSON.parse(entry.resource).route).toEqual(entry.key);
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

  function read(overrides: Record<string, unknown> = {}) {
    return {
      document: {
        document: DOCUMENT,
        documentKey: 'crdt-v1-app-1-workspace-1-principal-checklist-document-1',
        documentRevision: 1,
        lifecycle: 'active' as const,
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
      },
      existingUpdate: null,
      existingAppend: null,
      records: [],
      snapshot: null,
      authorized: true,
      authorizationCode: 'allowed',
      actorUpdatesInWindow: 0,
      storedSnapshotBytes: 0,
      featureDecision: {
        allowed: true,
        code: 'allowed' as const,
        reason: 'enabled',
        rollout: 'production' as const,
        retryable: false,
      },
    };
  }

  function updateEnvelope(updateId: string): RallarCrdtUpdateEnvelope {
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
        kind: 'batch' as const,
        operations: [
          {
            kind: 'register.set' as const,
            path: ['title'],
            policy: 'lww' as const,
            value: updateId,
          },
        ],
      },
    };
  }
});
