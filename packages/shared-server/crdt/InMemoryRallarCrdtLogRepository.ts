import {
  byteLengthOfRallarCrdtJson,
  createRallarCrdtAdminDocumentStatus,
  createRallarCrdtBackupBundle,
  createRallarCrdtDebugBundle,
  evaluateRallarCrdtFeaturePolicy,
  fromRallarCrdtAppendCursor,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtAdminLogRepository,
  type RallarCrdtAppendBatchInput,
  type RallarCrdtAppendBatchResult,
  type RallarCrdtAppendResult,
  type RallarCrdtAppendUpdateInput,
  type RallarCrdtAuditEventKind,
  type RallarCrdtAuditSink,
  type RallarCrdtBackupBundle,
  type RallarCrdtDebugBundle,
  type RallarCrdtDocumentAdminPage,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtDurableUpdateRecord,
  type RallarCrdtIntegrityReport,
  type RallarCrdtLifecycleInput,
  type RallarCrdtListDocumentsInput,
  type RallarCrdtListUpdatesInput,
  type RallarCrdtMetricsSink,
  type RallarCrdtOperationBatch,
  type RallarCrdtProjectionHooks,
  type RallarCrdtRestoreResult,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtValidationOptions,
  type RallarCrdtWriteSnapshotInput,
  toRallarCrdtAppendCursor,
  toRallarCrdtDocumentKey,
  validateRallarCrdtSnapshotEnvelope,
  validateRallarCrdtUpdateEnvelope,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';
export type InMemoryRallarCrdtLogRepositoryOptions<
  TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
> = Readonly<{
  now?: () => number;
  serverId?: string;
  validation?: RallarCrdtValidationOptions;
  hooks?: RallarCrdtProjectionHooks<TPayload>;
  policies?: readonly RallarCrdtDocumentTypePolicy[];
  metrics?: RallarCrdtMetricsSink;
  audit?: RallarCrdtAuditSink;
}>;
type DocumentState<TPayload, TValue> = {
  metadata: RallarCrdtDocumentMetadata;
  records: RallarCrdtDurableUpdateRecord<TPayload>[];
  snapshot?: RallarCrdtSnapshotEnvelope<TValue>;
};
export class InMemoryRallarCrdtLogRepository<
  TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
  TValue = unknown,
> implements RallarCrdtAdminLogRepository<TPayload, TValue> {
  private readonly documents = new Map<
    string,
    DocumentState<TPayload, TValue>
  >();
  private readonly now: () => number;
  private readonly serverId?: string;
  private readonly validation?: RallarCrdtValidationOptions;
  private readonly hooks?: RallarCrdtProjectionHooks<TPayload>;
  private readonly policies: readonly RallarCrdtDocumentTypePolicy[];
  private readonly metrics?: RallarCrdtMetricsSink;
  private readonly audit?: RallarCrdtAuditSink;
  constructor(
    options: InMemoryRallarCrdtLogRepositoryOptions<TPayload> = {},
  ) {
    this.now = options.now ?? Date.now;
    this.serverId = options.serverId;
    this.validation = options.validation;
    this.hooks = options.hooks;
    this.policies = options.policies ?? [];
    this.metrics = options.metrics;
    this.audit = options.audit;
  }
  async append(
    input: RallarCrdtAppendUpdateInput<TPayload>,
  ): Promise<RallarCrdtAppendResult<TPayload>> {
    const startedAtEpochMs = this.now();
    const actorId = requireTrustedId(input.trusted.actorId, 'actorId');
    const principalId = requireTrustedId(input.trusted.principalId, 'principalId');
    const sessionId = requireTrustedId(input.trusted.sessionId, 'sessionId');
    const serverId = requireTrustedId(input.trusted.serverId ?? this.serverId, 'serverId');
    const validation = validateRallarCrdtUpdateEnvelope(
      input.update,
      '$',
      this.validation,
    );
    if (!validation.valid) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'invalid-update',
        reason: 'CRDT update envelope failed validation.',
        retryable: false,
        validation,
      });
    }
    const state = this.getOrCreateDocument(input.update.document);
    const policyDecision = evaluateRallarCrdtFeaturePolicy({
      document: input.update.document,
      operation: 'durable-append',
      policies: this.policies,
    });
    if (!policyDecision.allowed) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'feature-disabled',
        reason: policyDecision.reason,
        retryable: policyDecision.retryable,
        document: state.metadata,
      });
    }
    if (state.metadata.lifecycle === 'archived') {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'document-archived',
        reason: 'CRDT document is archived and no longer accepts writes.',
        retryable: false,
        document: state.metadata,
      });
    }
    if (state.metadata.lifecycle === 'destroyed') {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'document-destroyed',
        reason: 'CRDT document is destroyed and no longer accepts writes.',
        retryable: false,
        document: state.metadata,
      });
    }
    if (state.metadata.lifecycle === 'quarantined') {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'document-quarantined',
        reason: 'CRDT document is quarantined and no longer accepts writes.',
        retryable: false,
        document: state.metadata,
      });
    }
    const existing = state.records.find(
      (record) => record.update.updateId === input.update.updateId,
    );
    const acceptedUpdateHash = hashRallarCrdtUpdateEnvelope(input.update);
    if (existing) {
      if (existing.append.acceptedUpdateHash === acceptedUpdateHash) {
        return this.recordAppendResult(startedAtEpochMs, {
          status: 'duplicate',
          update: input.update,
          append: existing.append,
          document: state.metadata,
        });
      }
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'duplicate-hash-mismatch',
        reason: 'CRDT updateId already exists with a different canonical hash.',
        retryable: false,
        document: state.metadata,
      });
    }
    if (
      state.metadata.quota?.maxUpdateCount !== undefined &&
      state.metadata.updateCount >= state.metadata.quota.maxUpdateCount
    ) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'quota-exceeded',
        reason: 'CRDT document update quota is exhausted.',
        retryable: false,
        document: state.metadata,
      });
    }
    const updateBytes = byteLengthOfRallarCrdtJson(input.update);
    if (
      state.metadata.quota?.maxUpdateBytes !== undefined &&
      updateBytes > state.metadata.quota.maxUpdateBytes
    ) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'update-too-large',
        reason: 'CRDT update exceeds the document update-byte quota.',
        retryable: false,
        document: state.metadata,
      });
    }
    if (
      state.metadata.quota?.maxDocumentBytes !== undefined &&
      byteLengthOfRallarCrdtJson({
          snapshot: state.snapshot ?? null,
          updates: [
            ...state.records.map((record) => record.update),
            input.update,
          ],
        }) > state.metadata.quota.maxDocumentBytes
    ) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'quota-exceeded',
        reason: 'CRDT document exceeds the document-byte quota.',
        retryable: false,
        document: state.metadata,
      });
    }
    if (
      this.isRateLimited(
        state,
        actorId,
        principalId,
        startedAtEpochMs,
      )
    ) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'rate-limited',
        reason: 'CRDT document actor update-rate limit is exhausted.',
        retryable: true,
        document: state.metadata,
      });
    }
    const appendSequence = state.metadata.lastAppendSequence + 1;
    const acceptedAtEpochMs = input.trusted.acceptedAtEpochMs ?? this.now();
    const append = {
      appendSequence,
      acceptedAtEpochMs,
      actorId,
      principalId,
      sessionId,
      serverId,
      authorizationScope: input.trusted.authorizationScope,
      acceptedUpdateHash,
    };
    const record: RallarCrdtDurableUpdateRecord<TPayload> = {
      document: input.update.document,
      documentKey: state.metadata.documentKey,
      update: input.update,
      append,
    };
    state.records.push(record);
    state.metadata = {
      ...state.metadata,
      documentRevision: state.metadata.documentRevision + 1,
      updatedAtEpochMs: acceptedAtEpochMs,
      lastAppendSequence: appendSequence,
      updateCount: state.records.length,
      storedUpdateBytes: state.metadata.storedUpdateBytes + updateBytes,
    };

    await this.hooks?.onAppendAccepted?.(record);

    return this.recordAppendResult(startedAtEpochMs, {
      status: 'accepted',
      update: input.update,
      append,
      document: state.metadata,
    });
  }

  async appendBatch(
    input: RallarCrdtAppendBatchInput<TPayload>,
  ): Promise<RallarCrdtAppendBatchResult<TPayload>> {
    const expectedKey = toRallarCrdtDocumentKey(input.document);
    const results: RallarCrdtAppendResult<TPayload>[] = [];

    for (const appendInput of input.updates) {
      if (
        toRallarCrdtDocumentKey(appendInput.update.document) !==
          expectedKey
      ) {
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

      if (
        input.stopOnFirstRejection &&
        results[results.length - 1]?.status === 'rejected'
      ) {
        break;
      }
    }

    const rejectedCount = results.filter(
      (result) => result.status === 'rejected',
    ).length;

    return {
      status: rejectedCount === 0
        ? 'accepted'
        : rejectedCount === results.length
        ? 'rejected'
        : 'partial',
      document: input.document,
      results,
    };
  }

  async listAfter(input: RallarCrdtListUpdatesInput): Promise<{
    document: typeof input.document;
    records: readonly RallarCrdtDurableUpdateRecord<TPayload>[];
    firstSequence?: number;
    lastSequence?: number;
    nextCursor?: string;
    hasMore: boolean;
  }> {
    const state = this.documents.get(
      toRallarCrdtDocumentKey(input.document),
    );
    const afterSequence = input.afterSequence ??
      fromRallarCrdtAppendCursor(input.afterCursor) ??
      0;
    const limit = Math.max(0, input.limit ?? 100);
    const allRecords = state?.records.filter(
      (record) => record.append.appendSequence > afterSequence,
    ) ?? [];
    const records = allRecords.slice(0, limit);
    const lastSequence = records.at(-1)?.append.appendSequence;

    return {
      document: input.document,
      records,
      firstSequence: records[0]?.append.appendSequence,
      lastSequence,
      nextCursor: lastSequence !== undefined ? toRallarCrdtAppendCursor(lastSequence) : undefined,
      hasMore: records.length < allRecords.length,
    };
  }

  async readSnapshot(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtSnapshotEnvelope<TValue> | undefined> {
    return this.documents.get(toRallarCrdtDocumentKey(document))?.snapshot;
  }

  async writeSnapshot(
    input: RallarCrdtWriteSnapshotInput<TValue>,
  ): Promise<void> {
    const validation = validateRallarCrdtSnapshotEnvelope(input.snapshot);
    if (!validation.valid) {
      throw new Error('CRDT snapshot envelope failed validation.');
    }

    const state = this.getOrCreateDocument(input.snapshot.document);
    if (
      state.metadata.quota?.maxDocumentBytes !== undefined &&
      byteLengthOfRallarCrdtJson({
          snapshot: input.snapshot,
          updates: state.records.map((record) => record.update),
        }) > state.metadata.quota.maxDocumentBytes
    ) {
      throw new Error('CRDT snapshot exceeds the document-byte quota.');
    }
    state.snapshot = input.snapshot;
    state.metadata = {
      ...state.metadata,
      documentRevision: state.metadata.documentRevision + 1,
      updatedAtEpochMs: input.snapshot.createdAtEpochMs,
      snapshotCount: state.metadata.snapshotCount + 1,
    };
    if (input.reason?.includes('compact')) {
      this.recordAudit('compact', state.metadata.documentKey, {
        appendSequence: input.appendSequence,
        reason: input.reason,
      });
    }
  }

  async readDocumentMetadata(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtDocumentMetadata | undefined> {
    return this.documents.get(toRallarCrdtDocumentKey(document))?.metadata;
  }

  async updateDocumentLifecycle(
    input: RallarCrdtLifecycleInput,
  ): Promise<RallarCrdtDocumentMetadata> {
    const state = this.getOrCreateDocument(input.document);
    const previousLifecycle = state.metadata.lifecycle;
    const changedAtEpochMs = input.changedAtEpochMs ?? this.now();
    state.metadata = {
      ...state.metadata,
      documentRevision: state.metadata.documentRevision + 1,
      lifecycle: input.lifecycle,
      updatedAtEpochMs: changedAtEpochMs,
      archivedAtEpochMs: input.lifecycle === 'archived'
        ? changedAtEpochMs
        : state.metadata.archivedAtEpochMs,
      destroyedAtEpochMs: input.lifecycle === 'destroyed'
        ? changedAtEpochMs
        : state.metadata.destroyedAtEpochMs,
      retention: input.retention ?? state.metadata.retention,
      quota: input.quota ?? state.metadata.quota,
      projectionIds: input.projectionIds ?? state.metadata.projectionIds,
    };

    await this.hooks?.onLifecycleChanged?.(state.metadata);
    const auditKind = toLifecycleAuditKind(
      input.lifecycle,
      previousLifecycle,
    );
    if (auditKind) {
      this.recordAudit(auditKind, state.metadata.documentKey, {
        lifecycle: input.lifecycle,
      });
    }
    return state.metadata;
  }

  async listDocuments(
    input: RallarCrdtListDocumentsInput = {},
  ): Promise<RallarCrdtDocumentAdminPage> {
    const limit = Math.max(0, input.limit ?? 100);
    const documents = Array.from(this.documents.values())
      .map((state) => state.metadata)
      .filter((metadata) => matchesDocumentListInput(metadata, input))
      .sort((left, right) => left.documentKey.localeCompare(right.documentKey));
    const startIndex = input.cursor
      ? documents.findIndex(
        (metadata) => metadata.documentKey > input.cursor!,
      )
      : 0;
    const safeStartIndex = startIndex < 0 ? documents.length : startIndex;
    const selected = documents.slice(
      safeStartIndex,
      safeStartIndex + limit,
    );

    return {
      documents: selected.map((metadata) =>
        createRallarCrdtAdminDocumentStatus({
          metadata,
          rollout: this.rolloutFor(metadata.document),
          quarantineReason: metadata.lifecycle === 'quarantined'
            ? 'document lifecycle is quarantined'
            : undefined,
        })
      ),
      nextCursor: selected.at(-1)?.documentKey,
      hasMore: safeStartIndex + selected.length < documents.length,
    };
  }

  async exportDebugBundle(
    document: RallarCrdtDocumentRef,
    options: Readonly<{
      reason?: string;
      exportedAtEpochMs?: number;
      redaction?: Parameters<
        typeof createRallarCrdtDebugBundle
      >[0]['redaction'];
    }> = {},
  ): Promise<RallarCrdtDebugBundle<TPayload>> {
    const state = this.getOrCreateDocument(document);
    const redacted = options.redaction?.payloadsRedacted ?? false;
    this.recordAudit('export', state.metadata.documentKey, {
      reason: options.reason ?? 'operator-export',
      redacted,
    });
    return createRallarCrdtDebugBundle({
      exportedAtEpochMs: options.exportedAtEpochMs ?? this.now(),
      reason: options.reason ?? 'operator-export',
      document,
      metadata: state.metadata,
      snapshot: state.snapshot as RallarCrdtSnapshotEnvelope | undefined,
      records: state.records,
      redaction: options.redaction,
    });
  }

  async exportBackupBundle(
    document: RallarCrdtDocumentRef,
    options: Readonly<{
      exportedAtEpochMs?: number;
    }> = {},
  ): Promise<RallarCrdtBackupBundle<TPayload> | undefined> {
    const state = this.documents.get(toRallarCrdtDocumentKey(document));
    if (!state) {
      return undefined;
    }

    this.recordAudit('backup', state.metadata.documentKey);
    return createRallarCrdtBackupBundle({
      exportedAtEpochMs: options.exportedAtEpochMs ?? this.now(),
      document,
      metadata: state.metadata,
      snapshot: state.snapshot as RallarCrdtSnapshotEnvelope | undefined,
      records: state.records,
    });
  }

  async restoreBackupBundle(
    bundle: RallarCrdtBackupBundle<TPayload>,
    options: Readonly<{
      overwrite?: boolean;
    }> = {},
  ): Promise<RallarCrdtRestoreResult> {
    const report = verifyRallarCrdtDebugBundle(bundle);
    if (!report.valid) {
      throw new Error(
        `CRDT backup bundle failed integrity verification: ${report.issues[0]?.message}`,
      );
    }

    const existing = this.documents.get(bundle.documentKey);
    if (existing && !options.overwrite) {
      throw new Error(
        `CRDT document already exists: ${bundle.documentKey}`,
      );
    }

    this.documents.set(bundle.documentKey, {
      metadata: bundle.metadata,
      records: [...bundle.records],
      snapshot: bundle.snapshot as
        | RallarCrdtSnapshotEnvelope<TValue>
        | undefined,
    });
    this.recordAudit('restore', bundle.documentKey, {
      updateCount: bundle.records.length,
      overwrite: options.overwrite === true,
    });

    return {
      document: bundle.document,
      documentKey: bundle.documentKey,
      restoredUpdateCount: bundle.records.length,
      restoredSnapshot: bundle.snapshot !== undefined,
      firstAppendSequence: bundle.integrity.firstAppendSequence,
      lastAppendSequence: bundle.integrity.lastAppendSequence,
    };
  }

  async verifyIntegrity(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtIntegrityReport> {
    return verifyRallarCrdtDebugBundle(
      await this.exportDebugBundle(document, {
        reason: 'integrity-check',
      }),
    );
  }

  async rebuildProjection(
    document: RallarCrdtDocumentRef,
    projectionId = 'default',
  ): Promise<RallarCrdtIntegrityReport> {
    const report = await this.verifyIntegrity(document);
    if (report.valid) {
      await this.hooks?.rebuild?.(document);
      await this.updateDocumentLifecycle({
        document,
        lifecycle: 'active',
        projectionIds: [projectionId],
      });
      this.recordAudit('rebuild', toRallarCrdtDocumentKey(document), {
        projectionId,
      });
    }
    return report;
  }

  private rolloutFor(document: RallarCrdtDocumentRef) {
    return (
      this.policies.find(
        (policy) =>
          (policy.documentType === '*' ||
            policy.documentType === document.documentType) &&
          (policy.scope === undefined ||
            policy.scope === 'any' ||
            policy.scope === document.scope) &&
          (policy.applicationId === undefined ||
            policy.applicationId === document.applicationId) &&
          (policy.workspaceId === undefined ||
            policy.workspaceId === document.workspaceId),
      )?.rollout ?? 'production'
    );
  }

  private isRateLimited(
    state: DocumentState<TPayload, TValue>,
    actorId: string | undefined,
    principalId: string | undefined,
    nowEpochMs: number,
  ): boolean {
    const maxUpdates = state.metadata.quota?.maxUpdatesPerMinutePerActor;
    if (maxUpdates === undefined) {
      return false;
    }

    const actorKey = actorId ?? principalId;
    if (!actorKey) {
      return false;
    }

    const windowStart = nowEpochMs - 60_000;
    const count = state.records.filter((record) => {
      const recordActor = record.append.actorId ?? record.append.principalId;
      return (
        recordActor === actorKey &&
        record.append.acceptedAtEpochMs >= windowStart
      );
    }).length;

    return count >= maxUpdates;
  }

  private recordAppendResult(
    startedAtEpochMs: number,
    result: RallarCrdtAppendResult<TPayload>,
  ): RallarCrdtAppendResult<TPayload> {
    const document = result.update?.document ?? result.document?.document;
    const documentKey = document ? toRallarCrdtDocumentKey(document) : result.document?.documentKey;
    void this.metrics?.record({
      name: 'crdt.server.append.ms',
      value: Math.max(0, this.now() - startedAtEpochMs),
      atEpochMs: this.now(),
      documentKey,
      tags: {
        status: result.status,
      },
    });
    if (result.status === 'rejected') {
      void this.metrics?.record({
        name: 'crdt.server.append.rejected.count',
        value: 1,
        atEpochMs: this.now(),
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

  private recordAudit(
    kind: RallarCrdtAuditEventKind,
    documentKey: string | undefined,
    metadata?: Readonly<Record<string, string | number | boolean>>,
  ): void {
    void this.audit?.record({
      kind,
      atEpochMs: this.now(),
      documentKey,
      metadata,
    });
  }

  private getOrCreateDocument(
    document: RallarCrdtDocumentRef,
  ): DocumentState<TPayload, TValue> {
    const documentKey = toRallarCrdtDocumentKey(document);
    const existing = this.documents.get(documentKey);
    if (existing) {
      return existing;
    }

    const now = this.now();
    const created: DocumentState<TPayload, TValue> = {
      metadata: {
        document,
        documentKey,
        documentRevision: 0,
        lifecycle: 'active',
        createdAtEpochMs: now,
        updatedAtEpochMs: now,
        archivedAtEpochMs: null,
        destroyedAtEpochMs: null,
        lastAppendSequence: 0,
        updateCount: 0,
        snapshotCount: 0,
        storedUpdateBytes: 0,
        retention: null,
        quota: null,
        projectionIds: [],
      },
      records: [],
    };
    this.documents.set(documentKey, created);
    return created;
  }
}

function requireTrustedId(value: string | undefined, label: string): string {
  if (!value) throw new TypeError(`CRDT trusted ${label} is required`);
  return value;
}

function toLifecycleAuditKind(
  lifecycle: RallarCrdtDocumentMetadata['lifecycle'],
  previousLifecycle: RallarCrdtDocumentMetadata['lifecycle'],
): RallarCrdtAuditEventKind | undefined {
  switch (lifecycle) {
    case 'archived':
      return 'archive';
    case 'quarantined':
      return 'quarantine';
    case 'destroyed':
      return 'destroy';
    case 'active':
      return previousLifecycle === 'active' ? undefined : 'restore';
  }
}

function matchesDocumentListInput(
  metadata: RallarCrdtDocumentMetadata,
  input: RallarCrdtListDocumentsInput,
): boolean {
  return (
    (input.applicationId === undefined ||
      metadata.document.applicationId === input.applicationId) &&
    (input.workspaceId === undefined ||
      metadata.document.workspaceId === input.workspaceId) &&
    (input.scope === undefined ||
      metadata.document.scope === input.scope) &&
    (input.documentType === undefined ||
      metadata.document.documentType === input.documentType) &&
    (input.lifecycle === undefined ||
      metadata.lifecycle === input.lifecycle)
  );
}
