import {
  byteLengthOfRallarCrdtJson,
  evaluateRallarCrdtFeaturePolicy,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtAppendResult,
  type RallarCrdtAppendUpdateInput,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtDurableUpdateRecord,
  type RallarCrdtNonRetryableAppendRejectionCode,
  type RallarCrdtOperationBatch,
} from '@shared/crdt/mod.ts';

import type { InMemoryCrdtDocumentState } from './in-memory-crdt-document-store.ts';

interface InMemoryCrdtAppendIdentity {
  readonly actorId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly serverId: string;
}

export interface ComputeInMemoryCrdtAppendInput<TPayload extends RallarCrdtOperationBatch, TValue> {
  readonly appendInput: RallarCrdtAppendUpdateInput<TPayload>;
  readonly state: InMemoryCrdtDocumentState<TPayload, TValue>;
  readonly identity: InMemoryCrdtAppendIdentity;
  readonly policies: readonly RallarCrdtDocumentTypePolicy[];
  readonly nowEpochMs: number;
}

export type InMemoryCrdtAppendDecision<TPayload extends RallarCrdtOperationBatch, TValue> =
  | Readonly<{
      kind: 'complete';
      result: RallarCrdtAppendResult<TPayload>;
    }>
  | Readonly<{
      kind: 'append';
      appendInput: RallarCrdtAppendUpdateInput<TPayload>;
      state: InMemoryCrdtDocumentState<TPayload, TValue>;
      identity: InMemoryCrdtAppendIdentity;
      acceptedUpdateHash: string;
      updateBytes: number;
    }>;

export interface ComputeAcceptedInMemoryCrdtAppendInput<
  TPayload extends RallarCrdtOperationBatch,
  TValue,
> {
  readonly decision: Extract<InMemoryCrdtAppendDecision<TPayload, TValue>, { kind: 'append' }>;
  readonly acceptedAtEpochMs: number;
}

export interface InMemoryCrdtAcceptedAppend<TPayload extends RallarCrdtOperationBatch, TValue> {
  readonly result: RallarCrdtAppendResult<TPayload>;
  readonly nextState: InMemoryCrdtDocumentState<TPayload, TValue>;
  readonly record: RallarCrdtDurableUpdateRecord<TPayload>;
}

export function computeInMemoryCrdtAppend<TPayload extends RallarCrdtOperationBatch, TValue>(
  input: ComputeInMemoryCrdtAppendInput<TPayload, TValue>,
): InMemoryCrdtAppendDecision<TPayload, TValue> {
  const policyDecision = evaluateRallarCrdtFeaturePolicy({
    document: input.appendInput.update.document,
    operation: 'durable-append',
    policies: input.policies,
  });
  if (!policyDecision.allowed) {
    return rejected(input, 'feature-disabled', policyDecision.reason);
  }

  const lifecycleRejection = toLifecycleRejection(input);
  if (lifecycleRejection) {
    return lifecycleRejection;
  }

  const acceptedUpdateHash = hashRallarCrdtUpdateEnvelope(input.appendInput.update);
  const existingUpdateDecision = toExistingUpdateDecision(input, acceptedUpdateHash);
  if (existingUpdateDecision) {
    return existingUpdateDecision;
  }

  const updateBytes = byteLengthOfRallarCrdtJson(input.appendInput.update);
  const quotaRejection = toQuotaRejection(input, updateBytes);
  if (quotaRejection) {
    return quotaRejection;
  }
  if (isRateLimited(input)) {
    return {
      kind: 'complete',
      result: {
        status: 'rejected',
        update: input.appendInput.update,
        code: 'rate-limited',
        reason: 'CRDT document actor update-rate limit is exhausted.',
        retryable: true,
        document: input.state.metadata,
      },
    };
  }

  return {
    kind: 'append',
    appendInput: input.appendInput,
    state: input.state,
    identity: input.identity,
    acceptedUpdateHash,
    updateBytes,
  };
}

function toExistingUpdateDecision<TPayload extends RallarCrdtOperationBatch, TValue>(
  input: ComputeInMemoryCrdtAppendInput<TPayload, TValue>,
  acceptedUpdateHash: string,
): InMemoryCrdtAppendDecision<TPayload, TValue> | undefined {
  const existing = input.state.records.find(
    (record) => record.update.updateId === input.appendInput.update.updateId,
  );
  if (!existing) {
    return undefined;
  }
  if (existing.append.acceptedUpdateHash === acceptedUpdateHash) {
    return {
      kind: 'complete',
      result: {
        status: 'duplicate',
        update: input.appendInput.update,
        append: existing.append,
        document: input.state.metadata,
      },
    };
  }
  return rejected(
    input,
    'duplicate-hash-mismatch',
    'CRDT updateId already exists with a different canonical hash.',
  );
}

export function computeAcceptedInMemoryCrdtAppend<
  TPayload extends RallarCrdtOperationBatch,
  TValue,
>(
  input: ComputeAcceptedInMemoryCrdtAppendInput<TPayload, TValue>,
): InMemoryCrdtAcceptedAppend<TPayload, TValue> {
  const appendSequence = input.decision.state.metadata.lastAppendSequence + 1;
  const append = {
    appendSequence,
    acceptedAtEpochMs: input.acceptedAtEpochMs,
    actorId: input.decision.identity.actorId,
    principalId: input.decision.identity.principalId,
    sessionId: input.decision.identity.sessionId,
    serverId: input.decision.identity.serverId,
    authorizationScope: input.decision.appendInput.trusted.authorizationScope,
    acceptedUpdateHash: input.decision.acceptedUpdateHash,
  };
  const record: RallarCrdtDurableUpdateRecord<TPayload> = {
    document: input.decision.appendInput.update.document,
    documentKey: input.decision.state.metadata.documentKey,
    update: input.decision.appendInput.update,
    append,
  };
  const records = [...input.decision.state.records, record];
  const nextState: InMemoryCrdtDocumentState<TPayload, TValue> = {
    ...input.decision.state,
    metadata: {
      ...input.decision.state.metadata,
      documentRevision: input.decision.state.metadata.documentRevision + 1,
      updatedAtEpochMs: input.acceptedAtEpochMs,
      lastAppendSequence: appendSequence,
      updateCount: records.length,
      storedUpdateBytes:
        input.decision.state.metadata.storedUpdateBytes + input.decision.updateBytes,
    },
    records,
  };

  return {
    result: {
      status: 'accepted',
      update: input.decision.appendInput.update,
      append,
      document: nextState.metadata,
    },
    nextState,
    record,
  };
}

function toLifecycleRejection<TPayload extends RallarCrdtOperationBatch, TValue>(
  input: ComputeInMemoryCrdtAppendInput<TPayload, TValue>,
): InMemoryCrdtAppendDecision<TPayload, TValue> | undefined {
  switch (input.state.metadata.lifecycle) {
    case 'active':
      return undefined;
    case 'archived':
      return rejected(
        input,
        'document-archived',
        'CRDT document is archived and no longer accepts writes.',
      );
    case 'destroyed':
      return rejected(
        input,
        'document-destroyed',
        'CRDT document is destroyed and no longer accepts writes.',
      );
    case 'quarantined':
      return rejected(
        input,
        'document-quarantined',
        'CRDT document is quarantined and no longer accepts writes.',
      );
  }
}

function toQuotaRejection<TPayload extends RallarCrdtOperationBatch, TValue>(
  input: ComputeInMemoryCrdtAppendInput<TPayload, TValue>,
  updateBytes: number,
): InMemoryCrdtAppendDecision<TPayload, TValue> | undefined {
  const quota = input.state.metadata.quota;
  if (
    quota?.maxUpdateCount !== undefined &&
    input.state.metadata.updateCount >= quota.maxUpdateCount
  ) {
    return rejected(input, 'quota-exceeded', 'CRDT document update quota is exhausted.');
  }
  if (quota?.maxUpdateBytes !== undefined && updateBytes > quota.maxUpdateBytes) {
    return rejected(
      input,
      'update-too-large',
      'CRDT update exceeds the document update-byte quota.',
    );
  }
  if (
    quota?.maxDocumentBytes !== undefined &&
    byteLengthOfRallarCrdtJson({
      snapshot: input.state.snapshot ?? null,
      updates: [...input.state.records.map((record) => record.update), input.appendInput.update],
    }) > quota.maxDocumentBytes
  ) {
    return rejected(input, 'quota-exceeded', 'CRDT document exceeds the document-byte quota.');
  }
  return undefined;
}

function isRateLimited<TPayload extends RallarCrdtOperationBatch, TValue>(
  input: ComputeInMemoryCrdtAppendInput<TPayload, TValue>,
): boolean {
  const maxUpdates = input.state.metadata.quota?.maxUpdatesPerMinutePerActor;
  if (maxUpdates === undefined) {
    return false;
  }

  const windowStart = input.nowEpochMs - 60_000;
  const count = input.state.records.filter((record) => {
    const recordActor = record.append.actorId ?? record.append.principalId;
    return recordActor === input.identity.actorId && record.append.acceptedAtEpochMs >= windowStart;
  }).length;
  return count >= maxUpdates;
}

function rejected<TPayload extends RallarCrdtOperationBatch, TValue>(
  input: ComputeInMemoryCrdtAppendInput<TPayload, TValue>,
  code: RallarCrdtNonRetryableAppendRejectionCode,
  reason: string,
): InMemoryCrdtAppendDecision<TPayload, TValue> {
  return {
    kind: 'complete',
    result: {
      status: 'rejected',
      update: input.appendInput.update,
      code,
      reason,
      retryable: false,
      document: input.state.metadata,
    },
  };
}
