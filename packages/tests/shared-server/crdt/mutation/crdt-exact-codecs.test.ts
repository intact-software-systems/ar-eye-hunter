import { describe, expect, it } from 'vitest';
import {
  createRallarCrdtDebugBundle,
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import {
  decodeCrdtAuditEvent,
  decodeExactSnapshotEnvelope,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-value-codec.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'principal',
  documentType: 'checklist',
  documentId: 'document-1',
  principalId: 'principal-1',
};

describe('CRDT mutation exact nested codecs', () => {
  it('decodes scalar audit metadata and rejects nested metadata without rewriting base input errors', () => {
    const event = {
      kind: 'erase',
      atEpochMs: 2_000,
      documentKey: toRallarCrdtDocumentKey(DOCUMENT),
      principalId: 'principal-1',
      reason: 'privacy',
      metadata: { mode: 'destroy-document', attempts: 2, verified: true },
    } as const;

    expect(decodeCrdtAuditEvent(event)).toEqual(event);
    expect(() => decodeCrdtAuditEvent({ ...event, metadata: { mode: { nested: true } } })).toThrow(
      'CRDT audit outbox event is invalid',
    );
    expect(() => decodeCrdtAuditEvent(null)).toThrow('CRDT admin request must be an object');
  });

  it('rejects extra fields in authoritative update payload batches', async () => {
    await expect(
      createCrdtMutationCommand({
        operation: 'append',
        commandId: 'append-extra-payload',
        actor: actor(),
        capturedAtEpochMs: 2_000,
        expireAtEpochMs: 62_000,
        document: DOCUMENT,
        responseAudience: audience(),
        authorizationScope: 'principal',
        update: {
          protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
          document: DOCUMENT,
          updateId: 'update-extra-payload',
          replicaId: 'replica-1',
          lamport: 1,
          parents: [],
          schemaVersion: 1,
          operationVersion: RALLAR_CRDT_OPERATION_VERSION,
          createdAtEpochMs: 1_000,
          payload: {
            kind: 'batch',
            operations: [],
            unexpected: true,
          },
        },
      } as never),
    ).rejects.toThrow(/payload|batch|fields|exact/i);
  });

  it('rejects extra fields in authoritative erase debug bundles', () => {
    const bundle = JSON.parse(
      JSON.stringify(
        createRallarCrdtDebugBundle({
          exportedAtEpochMs: 2_000,
          reason: 'privacy',
          document: DOCUMENT,
          records: [],
          redaction: { payloadsRedacted: true },
        }),
      ),
    );

    expect(() =>
      decodeCrdtMutationResult({
        version: 1,
        operation: 'erase',
        status: 'accepted',
        commandId: 'erase-1',
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        documentRevision: 1,
        appendSequence: 0,
        code: null,
        request: {
          document: DOCUMENT,
          requestedAtEpochMs: 2_000,
          requestedBy: 'principal-1',
          reason: 'privacy',
          mode: 'redact-payloads',
        },
        auditEvent: {
          kind: 'redact',
          atEpochMs: 2_000,
          documentKey: toRallarCrdtDocumentKey(DOCUMENT),
          principalId: 'principal-1',
          reason: 'privacy',
          metadata: { mode: 'redact-payloads' },
        },
        metadata: metadata(),
        redactedBundle: { ...bundle, unexpected: true },
      }),
    ).toThrow(/bundle|fields|exact/i);
  });

  it('rejects extra fields in snapshot clocks and CRDT state sidecars', () => {
    const snapshot = {
      protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
      document: DOCUMENT,
      snapshotId: 'snapshot-1',
      schemaVersion: 1,
      createdAtEpochMs: 2_000,
      maxLamport: 0,
      includedUpdateIds: [],
      value: {},
      metadata: { updateCount: 0 },
    };
    expect(() =>
      decodeExactSnapshotEnvelope({
        ...snapshot,
        updateClock: { maxLamport: 0, replicaClocks: {}, unexpected: true },
      }),
    ).toThrow(/clock|fields|exact/i);
    expect(() =>
      decodeExactSnapshotEnvelope({
        ...snapshot,
        metadata: {
          updateCount: 0,
          crdtState: {
            format: 'rallar.crdt.state.v1',
            registers: {},
            sets: {},
            maps: {},
            sequences: {},
            unexpected: true,
          },
        },
      }),
    ).toThrow(/state|fields|exact/i);
  });

  it('rejects extra fields in optional append rejection payloads', () => {
    const rejection = {
      version: 1,
      operation: 'append',
      status: 'rejected',
      commandId: 'append-rejected',
      documentKey: toRallarCrdtDocumentKey(DOCUMENT),
      documentRevision: 1,
      appendSequence: null,
      code: 'quota-exceeded',
      appendResult: {
        status: 'rejected',
        code: 'quota-exceeded',
        reason: 'quota',
        retryable: false,
      },
    };
    expect(() =>
      decodeCrdtMutationResult({
        ...rejection,
        appendResult: {
          ...rejection.appendResult,
          validation: { valid: true, issues: [], unexpected: true },
        },
      }),
    ).toThrow(/validation|fields|exact/i);
    expect(() =>
      decodeCrdtMutationResult({
        ...rejection,
        appendResult: { ...rejection.appendResult, document: { ...metadata(), unexpected: true } },
      }),
    ).toThrow(/metadata|fields|exact/i);
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
    kind: 'principal' as const,
    senderSessionId: 'session-1',
    topicId: 'crdt.principal',
    contextId: 'principal-1',
  };
}

function metadata(): RallarCrdtDocumentMetadata {
  return {
    document: DOCUMENT,
    documentKey: toRallarCrdtDocumentKey(DOCUMENT),
    documentRevision: 1,
    lifecycle: 'active',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 2_000,
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
