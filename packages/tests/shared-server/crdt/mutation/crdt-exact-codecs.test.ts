// prettier-ignore
import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createRallarCrdtDebugBundle,
  hashRallarCrdtJson,
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import {
  createCrdtMutationCommand,
  decodeCrdtMutationCommand,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
// prettier-ignore
import { decodeCrdtMutationResult }
  from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
// prettier-ignore
import { decodeExactDebugBundle }
  from '@shared-server/rallar-system/crdt/mutation/decode-exact-debug-bundle.ts';
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
  it(
    'decodes scalar audit metadata and rejects nested metadata ' +
      'without rewriting base input errors',
    () => {
      const event = {
        kind: 'erase',
        atEpochMs: 2_000,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        principalId: 'principal-1',
        reason: 'privacy',
        metadata: { mode: 'destroy-document', attempts: 2, verified: true },
      } as const;

      expect(decodeCrdtAuditEvent(event)).toEqual(event);
      expect(() =>
        decodeCrdtAuditEvent({ ...event, metadata: { mode: { nested: true } } }),
      ).toThrow('CRDT audit outbox event is invalid');
      expect(() => decodeCrdtAuditEvent(null)).toThrow('CRDT admin request must be an object');
    },
  );

  it('rejects extra fields in authoritative update payload batches', async () => {
    const payload = {
      kind: 'batch' as const,
      operations: [],
    };
    Reflect.set(payload, 'unexpected', true);

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
          payload,
        },
      }),
    ).rejects.toThrow(/payload|batch|fields|exact/i);
  });

  it(
    'checks compact fields before the canonical command hash ' + 'without rewriting raw snapshots',
    () => {
      const command = compactCommand();
      const mismatchedReason = {
        ...command,
        snapshot: {
          ...command.snapshot,
          metadata: { ...command.snapshot.metadata, reason: 'other' },
        },
      };
      expect(() => decodeCrdtMutationCommand(withCommandHash(mismatchedReason))).toThrow(
        'CRDT compact snapshot reason differs from command reason',
      );

      expect(() =>
        decodeCrdtMutationCommand({ ...command, snapshotId: '', commandHash: 'bad-hash' }),
      ).toThrow('snapshotId must be a non-empty string');

      expect(() =>
        decodeCrdtMutationCommand(
          withCommandHash({
            ...command,
            reason: '',
            snapshot: {
              ...command.snapshot,
              metadata: { ...command.snapshot.metadata, updateCount: -1 },
            },
          }),
        ),
      ).toThrow('metadata updateCount must be a non-negative safe integer');
    },
  );

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

  it.each([
    ['numeric health fields', { lastServerAppendSequence: -1 }],
    ['sync error', { lastSyncError: 1 }],
    ['transport strategy', { transportStrategy: 'invalid' }],
    ['live transport', { lastLiveTransport: 'invalid' }],
    ['live send status', { lastLiveSendStatus: 1 }],
    ['quota numeric fields', { quota: { usageBytes: -1 } }],
    ['quota limit flag', { quota: { nearingLimit: 'yes' } }],
  ])('rejects invalid debug health %s', (_label, invalidHealth) => {
    expect(() => decodeExactDebugBundle(debugBundleWithHealth(invalidHealth))).toThrow();
  });

  it('accepts complete optional debug health values', () => {
    expect(
      decodeExactDebugBundle(
        debugBundleWithHealth({
          lastServerAppendSequence: 1,
          lastServerAckAtEpochMs: 2_000,
          lastSyncError: 'timeout',
          snapshotAgeMs: 1,
          updateLogLag: 2,
          quota: { usageBytes: 10, quotaBytes: 20, nearingLimit: false },
          replayDurationMs: 3,
          corruptLocalArtifactCount: 0,
          transportStrategy: 'ws-then-rtc',
          lastLiveTransport: 'ws',
          lastLiveSendStatus: 'sent',
          liveSentUpdateCount: 1,
          liveReceivedUpdateCount: 2,
          liveDuplicateUpdateCount: 0,
          liveRejectedUpdateCount: 0,
          liveDependencyBlockedUpdateCount: 0,
          liveRetriedUpdateCount: 0,
          liveSyncRequestCount: 1,
          liveSyncResponseCount: 1,
        }),
      ),
    ).toMatchObject({ health: { transportStrategy: 'ws-then-rtc' } });
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

function compactCommand() {
  const snapshot = {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    snapshotId: 'snapshot-1',
    schemaVersion: 1,
    createdAtEpochMs: 2_000,
    maxLamport: 0,
    includedUpdateIds: [],
    value: {},
    metadata: { updateCount: 0, reason: 'compact' },
  };
  return withCommandHash({
    version: 1 as const,
    operation: 'compact' as const,
    commandId: 'compact-command',
    deliveryId: 'compact-command',
    commandHash: '',
    actor: actor(),
    capturedAtEpochMs: 2_000,
    expireAtEpochMs: 62_000,
    document: DOCUMENT,
    documentKey: toRallarCrdtDocumentKey(DOCUMENT),
    responseAudience: audience(),
    snapshotId: 'snapshot-1',
    snapshot,
    reason: 'compact',
  });
}

function withCommandHash<T extends Record<string, unknown>>(command: T): T {
  const { commandHash: _commandHash, ...stable } = command;
  return { ...command, commandHash: hashRallarCrdtJson(stable) };
}

function debugBundleWithHealth(health: Record<string, unknown>) {
  const bundle = JSON.parse(
    JSON.stringify(
      createRallarCrdtDebugBundle({
        exportedAtEpochMs: 2_000,
        reason: 'health-check',
        document: DOCUMENT,
        records: [],
        redaction: { payloadsRedacted: false },
      }),
    ),
  );
  return {
    ...bundle,
    health: {
      replicaId: 'replica-1',
      pendingUpdateCount: 0,
      failedPendingUpdateCount: 0,
      dependencyBlockedUpdateCount: 0,
      seenUpdateCount: 0,
      ...health,
    },
  };
}
