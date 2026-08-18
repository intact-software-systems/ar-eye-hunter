import { describe, expect, it } from 'vitest';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import {
  type CrdtAppendCommand,
  type CrdtMutationCommand,
  type CrdtMutationComputed,
  type CrdtMutationRead,
  type CrdtMutationRepository,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
// Prettier's single-line form exceeds the repository's 100-character review limit.
// prettier-ignore
import {
  createCrdtMutationCommand,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
// Prettier's single-line form exceeds the repository's 100-character review limit.
// prettier-ignore
import {
  createCrdtMutationService,
} from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'document-1',
  roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
};

describe('CRDT command and outbox invariants', () => {
  it('writes a browser-compatible append response and fans out only accepted updates', async () => {
    const command = await appendCommand(update('update-1'));
    const accepted = compute(command, read());
    const acceptedWire = outboxPayload(accepted, 'reply');

    expect(accepted.outboxEntries).toHaveLength(2);
    expect(acceptedWire.results).toEqual([
      {
        status: 'accepted',
        update: command.update,
        append: accepted.append,
        document: accepted.document,
      },
    ]);

    const replay = compute(
      command,
      read({
        document: accepted.document,
        existingUpdate: command.update,
      }),
    );
    expect(replay.outboxEntries).toHaveLength(1);
    expect(outboxPayload(replay, 'reply').results[0]).toMatchObject({
      status: 'duplicate',
      update: command.update,
      append: accepted.append,
      document: accepted.document,
    });

    const denied = compute(command, read({ authorized: false }));
    expect(denied.outboxEntries).toHaveLength(0);
    expect(toAppendResult(denied)).toMatchObject({
      status: 'rejected',
      update: command.update,
      code: 'authorization-denied',
      retryable: false,
    });
  });

  it('rejects unknown fields in incoming update and generated WS payloads', async () => {
    const invalidUpdate = update('unknown');
    Reflect.set(invalidUpdate, 'unexpected', true);
    await expect(appendCommand(invalidUpdate)).rejects.toThrow(/update|field/i);
    const accepted = compute(await appendCommand(update('wire')), read());
    const wire = outboxMessage(accepted, 'reply');
    expect(Object.keys(wire).sort()).toEqual(
      ['audit', 'constraints', 'id', 'payload', 'route', 'targets'].sort(),
    );
    expect(Object.keys(wire.payload).sort()).toEqual(['contentType', 'resource', 'typeId'].sort());
  });

  it('includes snapshot bytes and actor rate facts in append policy', async () => {
    const command = await appendCommand(update('quota'));
    const current = metadata({
      quota: { maxDocumentBytes: 1_000, maxUpdatesPerMinutePerActor: 1 },
      storedUpdateBytes: 100,
    });
    const snapshot = snapshotFor(DOCUMENT, 'snapshot-large', 'x'.repeat(2_000));
    const computed = compute(
      command,
      read({
        document: current,
        snapshot,
        actorUpdatesInWindow: 1,
        storedSnapshotBytes: 2_000,
      }),
    );
    expect(computed).toMatchObject({ outcome: 'rejected', code: 'quota-exceeded' });
  });

  it('rejects a compact snapshot for a different physical document', async () => {
    const other = { ...DOCUMENT, documentId: 'other-document' };
    await expect(
      createCrdtMutationCommand({
        ...adminBase('compact'),
        operation: 'compact',
        snapshotId: 'wrong-snapshot',
        snapshot: snapshotFor(other, 'wrong-snapshot', {}),
        reason: 'compact',
      }),
    ).rejects.toThrow(/snapshot.*document/i);
  });

  it('preserves exact compact, lifecycle, rebuild, and erase results', async () => {
    const current = metadata({ lastAppendSequence: 7, updateCount: 1 });
    const compact = compute(
      await createCrdtMutationCommand({
        ...adminBase('compact'),
        operation: 'compact',
        snapshotId: 'compact-snapshot',
        snapshot: null,
        reason: 'compact',
      }),
      read({ document: current }),
    );
    expect(compact.result).toMatchObject({
      operation: 'compact',
      status: 'accepted',
      appendSequence: 7,
      snapshot: expect.objectContaining({ document: DOCUMENT }),
    });

    const lifecycle = compute(
      await createCrdtMutationCommand({
        ...adminBase('lifecycle'),
        operation: 'lifecycle',
        lifecycle: 'archived',
        retentionAction: { kind: 'preserve' },
        quotaAction: { kind: 'preserve' },
        projectionIdsAction: { kind: 'preserve' },
      }),
      read({ document: current }),
    );
    expect(lifecycle.result).toMatchObject({ metadata: { lifecycle: 'archived' } });

    const rebuild = compute(
      await createCrdtMutationCommand({
        ...adminBase('rebuild'),
        operation: 'rebuild-projection',
        projectionId: 'search',
      }),
      read({ document: current }),
    );
    expect(rebuild.result).toMatchObject({ integrity: { valid: true } });

    const erase = compute(
      await createCrdtMutationCommand({
        ...adminBase('erase'),
        operation: 'erase',
        mode: 'destroy-document',
        reason: 'privacy',
      }),
      read({ document: current }),
    );
    expect(erase.result).toMatchObject({
      request: { document: DOCUMENT, mode: 'destroy-document', reason: 'privacy' },
      auditEvent: { kind: 'erase' },
      metadata: { lifecycle: 'destroyed' },
    });
  });
});

function compute(command: CrdtMutationCommand, state: CrdtMutationRead): CrdtMutationComputed {
  const repository: CrdtMutationRepository = {
    readMutation: () => Promise.resolve(state),
    writeMutation: () => Promise.resolve(),
    writeOutbox: () => Promise.resolve(),
  };
  const service = createCrdtMutationService({
    repository,
    createWriter: () => repository,
    serviceId: 'server-1',
  });
  const computed = service.compute({ command, read: state });
  expect(service.validate({ command, read: state, computed })).toEqual([]);
  return computed;
}

function read(overrides: Partial<CrdtMutationRead> = {}): CrdtMutationRead {
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
      code: 'allowed',
      reason: 'test',
      rollout: 'production',
      retryable: false,
    },
    actorUpdatesInWindow: 0,
    storedSnapshotBytes: 0,
    ...overrides,
  };
}

async function appendCommand(input: RallarCrdtUpdateEnvelope): Promise<CrdtAppendCommand> {
  const command = await createCrdtMutationCommand({
    operation: 'append',
    commandId: input.updateId,
    actor: {
      actorId: 'actor-1',
      principalId: 'client-1',
      sessionId: 'session-1',
      serverId: 'server-1',
    },
    capturedAtEpochMs: 1_000,
    expireAtEpochMs: 61_000,
    document: DOCUMENT,
    responseAudience: {
      kind: 'room',
      senderSessionId: 'session-1',
      topicId: 'room.crdt',
      contextId: 'group-1',
    },
    update: input,
    authorizationScope: 'room',
  });
  if (command.operation !== 'append') {
    throw new TypeError(`Expected an append command, got ${command.operation}`);
  }
  return command;
}

function toAppendResult(computed: CrdtMutationComputed) {
  const { result } = computed;
  if (result.operation !== 'append') {
    throw new TypeError(`Expected an append result, got ${result.operation}`);
  }
  return result.appendResult;
}

function adminBase(commandId: string) {
  return {
    commandId,
    actor: {
      actorId: 'admin',
      principalId: 'admin',
      sessionId: 'admin-session',
      serverId: 'server-1',
    },
    capturedAtEpochMs: 1_000,
    expireAtEpochMs: 61_000,
    document: DOCUMENT,
    responseAudience: {
      kind: 'admin' as const,
      senderSessionId: 'admin-session',
      topicId: 'crdt.admin',
      contextId: 'document-1',
    },
  };
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
    createdAtEpochMs: 900,
    payload: {
      kind: 'batch',
      operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: updateId }],
    },
  };
}

function snapshotFor(
  document: RallarCrdtDocumentRef,
  snapshotId: string,
  value: unknown,
): RallarCrdtSnapshotEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document,
    snapshotId,
    schemaVersion: 1,
    createdAtEpochMs: 950,
    maxLamport: 0,
    includedUpdateIds: [],
    value,
    metadata: { updateCount: 0 },
  };
}

function metadata(overrides: Partial<RallarCrdtDocumentMetadata> = {}): RallarCrdtDocumentMetadata {
  return {
    document: DOCUMENT,
    documentKey: toRallarCrdtDocumentKey(DOCUMENT),
    documentRevision: 1,
    lifecycle: 'active',
    createdAtEpochMs: 500,
    updatedAtEpochMs: 500,
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

function outboxMessage(computed: CrdtMutationComputed, effect: string) {
  const entry = computed.outboxEntries.find((candidate) =>
    candidate.key.resourceId.endsWith(`:${effect}`),
  );
  if (!entry) throw new Error(`Missing ${effect} outbox entry`);
  return JSON.parse(entry.resource);
}

function outboxPayload(computed: CrdtMutationComputed, effect: string) {
  return JSON.parse(outboxMessage(computed, effect).payload.resource);
}
