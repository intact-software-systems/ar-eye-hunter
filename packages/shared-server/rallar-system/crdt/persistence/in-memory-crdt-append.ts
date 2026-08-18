import {
  type RallarCrdtAppendBatchInput,
  type RallarCrdtAppendBatchResult,
  type RallarCrdtAppendResult,
  type RallarCrdtAppendUpdateInput,
  type RallarCrdtAuditEventKind,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtMetricsSink,
  type RallarCrdtOperationBatch,
  type RallarCrdtProjectionHooks,
  type RallarCrdtValidationOptions,
  toRallarCrdtDocumentKey,
  validateRallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';

import {
  computeAcceptedInMemoryCrdtAppend,
  computeInMemoryCrdtAppend,
} from './compute-in-memory-crdt-append.ts';
import type { InMemoryCrdtDocumentStore } from './in-memory-crdt-document-store.ts';

export namespace InMemoryCrdtAppend {
  export interface Dependencies<TPayload extends RallarCrdtOperationBatch, TValue> {
    readonly documents: InMemoryCrdtDocumentStore<TPayload, TValue>;
    readonly recordAudit: (
      kind: RallarCrdtAuditEventKind,
      documentKey: string | undefined,
      metadata?: Readonly<Record<string, string | number | boolean>>,
    ) => void;
  }

  export interface Config<TPayload extends RallarCrdtOperationBatch> {
    readonly now: () => number;
    readonly serverId: string | undefined;
    readonly validation: RallarCrdtValidationOptions | undefined;
    readonly hooks: RallarCrdtProjectionHooks<TPayload> | undefined;
    readonly policies: readonly RallarCrdtDocumentTypePolicy[];
    readonly metrics: RallarCrdtMetricsSink | undefined;
  }
}

export class InMemoryCrdtAppend<TPayload extends RallarCrdtOperationBatch, TValue> {
  private readonly documents: InMemoryCrdtDocumentStore<TPayload, TValue>;
  private readonly recordAudit: InMemoryCrdtAppend.Dependencies<TPayload, TValue>['recordAudit'];
  private readonly config: InMemoryCrdtAppend.Config<TPayload>;

  constructor(
    dependencies: InMemoryCrdtAppend.Dependencies<TPayload, TValue>,
    config: InMemoryCrdtAppend.Config<TPayload>,
  ) {
    this.documents = dependencies.documents;
    this.recordAudit = dependencies.recordAudit;
    this.config = config;
  }

  async append(
    input: RallarCrdtAppendUpdateInput<TPayload>,
  ): Promise<RallarCrdtAppendResult<TPayload>> {
    const startedAtEpochMs = this.config.now();
    const identity = {
      actorId: requireTrustedId(input.trusted.actorId, 'actorId'),
      principalId: requireTrustedId(input.trusted.principalId, 'principalId'),
      sessionId: requireTrustedId(input.trusted.sessionId, 'sessionId'),
      serverId: requireTrustedId(input.trusted.serverId ?? this.config.serverId, 'serverId'),
    };
    const validation = validateRallarCrdtUpdateEnvelope(input.update, '$', this.config.validation);
    if (!validation.valid) {
      return this.recordResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'invalid-update',
        reason: 'CRDT update envelope failed validation.',
        retryable: false,
        validation,
      });
    }

    const state = this.documents.getOrCreate(input.update.document, () => this.config.now());
    const decision = computeInMemoryCrdtAppend({
      appendInput: input,
      state,
      identity,
      policies: this.config.policies,
      nowEpochMs: startedAtEpochMs,
    });
    if (decision.kind === 'complete') {
      return this.recordResult(startedAtEpochMs, decision.result);
    }

    const accepted = computeAcceptedInMemoryCrdtAppend({
      decision,
      acceptedAtEpochMs: input.trusted.acceptedAtEpochMs ?? this.config.now(),
    });
    this.documents.set(accepted.nextState.metadata.documentKey, accepted.nextState);
    await this.config.hooks?.onAppendAccepted?.(accepted.record);

    return this.recordResult(startedAtEpochMs, accepted.result);
  }

  async appendBatch(
    input: RallarCrdtAppendBatchInput<TPayload>,
  ): Promise<RallarCrdtAppendBatchResult<TPayload>> {
    const expectedKey = toRallarCrdtDocumentKey(input.document);
    const results: RallarCrdtAppendResult<TPayload>[] = [];

    for (const appendInput of input.updates) {
      if (toRallarCrdtDocumentKey(appendInput.update.document) !== expectedKey) {
        results.push({
          status: 'rejected',
          update: appendInput.update,
          code: 'invalid-update',
          reason: 'CRDT append batch contains an update for a different document.',
          retryable: false,
        });
      } else {
        results.push(await this.append(appendInput));
      }

      if (input.stopOnFirstRejection && results.at(-1)?.status === 'rejected') {
        break;
      }
    }

    const rejectedCount = results.filter((result) => result.status === 'rejected').length;
    return {
      status:
        rejectedCount === 0
          ? 'accepted'
          : rejectedCount === results.length
            ? 'rejected'
            : 'partial',
      document: input.document,
      results,
    };
  }

  private recordResult(
    startedAtEpochMs: number,
    result: RallarCrdtAppendResult<TPayload>,
  ): RallarCrdtAppendResult<TPayload> {
    const document = result.update?.document ?? result.document?.document;
    const documentKey = document ? toRallarCrdtDocumentKey(document) : result.document?.documentKey;
    void this.config.metrics?.record({
      name: 'crdt.server.append.ms',
      value: Math.max(0, this.config.now() - startedAtEpochMs),
      atEpochMs: this.config.now(),
      documentKey,
      tags: {
        status: result.status,
      },
    });
    if (result.status === 'rejected') {
      void this.config.metrics?.record({
        name: 'crdt.server.append.rejected.count',
        value: 1,
        atEpochMs: this.config.now(),
        documentKey,
        tags: {
          code: result.code,
        },
      });
      this.recordAudit('reject', documentKey, {
        code: result.code,
        retryable: result.retryable,
      });
    } else {
      this.recordAudit('append', documentKey, {
        status: result.status,
        appendSequence: result.append.appendSequence,
      });
    }
    return result;
  }
}

function requireTrustedId(value: string | undefined, label: string): string {
  if (!value) {
    throw new TypeError(`CRDT trusted ${label} is required`);
  }
  return value;
}
