import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  AdminMetricsResetCategory,
  AdminMetricsResetRequest,
  AdminOperationBaseResponse,
  AdminOperationResultResponse,
  AdminOperationsCrdtResponse,
  AdminOperationsOverviewResponse,
  AdminOperationsQueuesResponse,
  AdminOperationsRealtimeResponse,
  AdminOperationsStateResponse,
  AdminOperationsSystemResponse,
  AdminOperationWarning,
  AdminPruneExpiredCategory,
  AdminPruneExpiredRequest,
  AdminTopologyRecomputeRequest,
} from '@shared/api/admin-operations-types.ts';
import {
  ADMIN_METRICS_RESET_CATEGORIES,
  ADMIN_PRUNE_EXPIRED_CATEGORIES,
} from '@shared/api/admin-operations-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { PrincipalId } from '@shared/api/group-types.ts';
import {
  createRallarCrdtCompactedSnapshot,
  createRallarCrdtErasureAuditEvent,
  type RallarCrdtAdminLogRepository,
  type RallarCrdtAuditSink,
  type RallarCrdtDocumentRef,
  type RallarCrdtErasureRequest,
  type RallarCrdtLifecycleInput,
  type RallarCrdtSnapshotEnvelope,
} from '@shared/crdt/mod.ts';
import {
  nowMs,
  type RallarTimingDetails,
  type RallarTimingEventInput,
  type RallarTimingSink,
  recordRallarTiming,
} from '../services/timing.ts';
import {
  readAdminCrdtErasureMode,
  readAdminCrdtLifecycle,
} from './crdt-admin-validation.ts';
import type { AdminOperationsMutationGateway } from './admin-operations-mutation-gateway.ts';
export type AdminOperationsReadInput = Readonly<{
  adminSession: AuthSession;
  scope?: StateScope;
}>;
export type AdminOperationsWriteInput<TRequest> = Readonly<{
  adminSession: AuthSession;
  request: TRequest;
}>;
export type AdminOperationsStatsReader = Readonly<{
  readQueues(input: AdminOperationsReadInput): Promise<AdminOperationsQueuesResponse>;
  readState(input: AdminOperationsReadInput): Promise<AdminOperationsStateResponse>;
  readCrdt(input: AdminOperationsReadInput): Promise<AdminOperationsCrdtResponse>;
  readSystem(input: AdminOperationsReadInput): Promise<AdminOperationsSystemResponse>;
}>;
export type AdminOperationsPruner = Readonly<{
  countExpired(
    category: AdminPruneExpiredCategory,
    options: AdminPruneExpiredOptions,
  ): Promise<number>;
  pruneExpired(
    category: AdminPruneExpiredCategory,
    options: AdminPruneExpiredOptions,
  ): Promise<number>;
}>;
export type AdminPruneExpiredOptions = Readonly<{
  appData?: Readonly<{
    namespace?: string;
    storeName?: string;
  }>;
}>;
export type AdminOperationsTopologyManagement = Readonly<{
  reconfigureGroupTopology(input: unknown): Promise<unknown>;
}>;
export type AdminOperationsServiceOptions = Readonly<{
  now: () => number;
  serverId?: string;
  statsReader: AdminOperationsStatsReader;
  pruner?: AdminOperationsPruner;
  wsStatus?: () => AdminRealtimeWsStatus;
  readRtcTopologyMetrics?: () => unknown;
  resetRtcTopologyMetrics?: () => void;
  topologyManagement?: AdminOperationsTopologyManagement;
  crdtAdminRepository?: Partial<RallarCrdtAdminLogRepository>;
  crdtAuditSink?: RallarCrdtAuditSink;
  timing?: RallarTimingSink;
  mutationGateway?: AdminOperationsMutationGateway;
}>;

export type AdminRealtimeWsStatus = Readonly<{
  connectionCount: number;
  openConnectionCount: number;
  connectionIds: readonly string[];
  openConnectionIds: readonly string[];
  connections?: readonly unknown[];
}>;

type AdminOperationRequest = Readonly<{
  requestId?: string;
  reason?: string;
  [key: string]: unknown;
}>;

export class AdminOperationsService {
  constructor(private readonly options: AdminOperationsServiceOptions) {}

  async readOverview(input: AdminOperationsReadInput): Promise<AdminOperationsOverviewResponse> {
    const [queues, state, crdt, system] = await Promise.all([
      this.options.statsReader.readQueues(input),
      this.options.statsReader.readState(input),
      this.options.statsReader.readCrdt(input),
      this.options.statsReader.readSystem(input),
    ]);
    const realtime = await this.readRealtime(input);
    const warnings = [
      ...queues.warnings,
      ...state.warnings,
      ...crdt.warnings,
      ...system.warnings,
      ...realtime.warnings,
    ];

    return {
      ...this.base(input.scope, warnings),
      health: {
        status: warnings.some((warning) => warning.code !== 'process-local-realtime')
          ? 'warning'
          : 'ok',
      },
      websocket: {
        connectionCount: realtime.websocket.connectionCount,
        openConnectionCount: realtime.websocket.openConnectionCount,
      },
      queues: {
        queuedRows: queues.queueRows.total,
        resultRows: queues.resultRows.total,
        expiredRows: queues.queueRows.expired + queues.resultRows.expired,
      },
      realtime: {
        topologyMetrics: realtime.rtcTopology.metrics,
      },
      state: {
        activeSessions: state.clients.activeSessions,
        activeGroups: state.groups.activeGroups,
      },
      crdt: {
        documents: crdt.documents.total,
        updates: crdt.storage.updates,
        snapshots: crdt.storage.snapshots,
        storedUpdateBytes: crdt.storage.storedUpdateBytes,
      },
      system: {
        runtimeStateRows: system.runtimeState.rows,
        appDataRows: system.appData.rows,
      },
    };
  }

  async readQueues(input: AdminOperationsReadInput): Promise<AdminOperationsQueuesResponse> {
    return await this.options.statsReader.readQueues(input);
  }

  async readRealtime(input: AdminOperationsReadInput): Promise<AdminOperationsRealtimeResponse> {
    const status = this.options.wsStatus?.() ?? {
      connectionCount: 0,
      openConnectionCount: 0,
      connectionIds: [],
      openConnectionIds: [],
    };
    return {
      ...this.base(input.scope, [{
        code: 'process-local-realtime',
        message: 'Realtime metrics are process-local in multi-server deployments.',
        source: 'ws',
      }]),
      websocket: {
        connectionCount: status.connectionCount,
        openConnectionCount: status.openConnectionCount,
        connectionIds: status.connectionIds.slice(0, 50),
        openConnectionIds: status.openConnectionIds.slice(0, 50),
      },
      rtcTopology: {
        metrics: this.options.readRtcTopologyMetrics?.(),
        processLocal: true,
      },
    };
  }

  async readState(input: AdminOperationsReadInput): Promise<AdminOperationsStateResponse> {
    return await this.options.statsReader.readState(input);
  }

  async readCrdt(input: AdminOperationsReadInput): Promise<AdminOperationsCrdtResponse> {
    return await this.options.statsReader.readCrdt(input);
  }

  async readSystem(input: AdminOperationsReadInput): Promise<AdminOperationsSystemResponse> {
    return await this.options.statsReader.readSystem(input);
  }

  async resetMetrics(
    input: AdminOperationsWriteInput<AdminMetricsResetRequest>,
  ): Promise<AdminOperationResultResponse> {
    return await this.timeWrite('metrics.reset', input, async () => {
      const request = readObject(input.request);
      const categories = readMetricsResetCategories(request.categories);
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      let changed = false;

      for (const category of categories) {
        if (category !== 'rtc-topology') {
          continue;
        }
        before.rtcTopology = this.options.readRtcTopologyMetrics?.();
        this.options.resetRtcTopologyMetrics?.();
        after.rtcTopology = this.options.readRtcTopologyMetrics?.();
        changed = true;
      }

      return {
        ...this.base(),
        operation: 'metrics.reset',
        status: 'completed',
        changed,
        before,
        after,
      };
    });
  }

  async recomputeTopology(
    input: AdminOperationsWriteInput<AdminTopologyRecomputeRequest>,
  ): Promise<AdminOperationResultResponse> {
    if (this.options.mutationGateway) return await this.options.mutationGateway.recomputeTopology(input) as AdminOperationResultResponse;
    return await this.timeWrite('topology.recompute', input, async () => {
      if (!input.request.groupRef) {
        throw new Error('Admin topology recompute requires groupRef.');
      }
      if (!this.options.topologyManagement) {
        throw new Error('Topology management is not configured.');
      }

      const result = await this.options.topologyManagement.reconfigureGroupTopology({
        groupRef: input.request.groupRef,
        requestOptions: input.request.options,
        publish: input.request.publish ?? true,
        requestId: input.request.requestId,
      });

      return {
        ...this.base(),
        operation: 'topology.recompute',
        status: 'completed',
        changed: readChanged(result),
        after: result,
      };
    });
  }

  async pruneExpired(
    input: AdminOperationsWriteInput<AdminPruneExpiredRequest>,
  ): Promise<AdminOperationResultResponse> {
    if (this.options.mutationGateway) return await this.options.mutationGateway.pruneExpired(input) as AdminOperationResultResponse;
    return await this.timeWrite('maintenance.prune-expired', input, async () => {
      if (!this.options.pruner) {
        throw new Error('Admin expiry pruning is not configured.');
      }

      const request = readObject(input.request);
      const dryRun = readOptionalBoolean(request.dryRun, 'dryRun') ?? true;
      const categories = readPruneExpiredCategories(request.categories);
      const options = { appData: readAppDataPruneOptions(request.appData) };
      const results = [];
      let changed = false;

      for (const category of categories) {
        if (category === 'app-data' && !options.appData?.namespace) {
          throw new Error('appData.namespace is required for app-data pruning.');
        }
        const expiredRows = await this.options.pruner.countExpired(category, options);
        const deletedRows = dryRun ? 0 : await this.options.pruner.pruneExpired(category, options);
        if (deletedRows > 0) {
          changed = true;
        }
        results.push({
          category,
          expiredRows,
          deletedRows,
          dryRun,
        });
      }

      return {
        ...this.base(),
        operation: 'maintenance.prune-expired',
        status: dryRun ? 'dry-run' : 'completed',
        changed,
        results,
      };
    });
  }

  async verifyCrdtIntegrity(
    input: AdminOperationsWriteInput<unknown>,
  ): Promise<unknown> {
    return await this.timeWrite(
      'crdt.integrity',
      input,
      async () =>
        await this.requireCrdtRepository('verifyIntegrity')
          .verifyIntegrity(readDocument(input.request)),
    );
  }

  async exportCrdtDebug(
    input: AdminOperationsWriteInput<unknown>,
  ): Promise<unknown> {
    return await this.timeWrite('crdt.debug-export', input, async () => {
      const body = readObject(input.request);
      const redactPayloads = body.redactPayloads === false ? false : true;
      return await this.requireCrdtRepository('exportDebugBundle')
        .exportDebugBundle(readDocument(input.request), {
          reason: readReason(body, 'api-v1-admin-operations-debug-export'),
          redaction: redactPayloads
            ? {
              payloadsRedacted: true,
              reason: 'api-v1-admin-operations-redaction',
            }
            : { payloadsRedacted: false },
        });
    });
  }

  async compactCrdt(input: AdminOperationsWriteInput<unknown>): Promise<unknown> {
    if (this.options.mutationGateway) return await this.options.mutationGateway.compactCrdt(input);
    return await this.timeWrite('crdt.compact', input, async () => {
      const repository = this.requireCrdtRepository('writeSnapshot');
      const body = readObject(input.request) as {
        snapshot?: RallarCrdtSnapshotEnvelope;
      };
      const document = readDocument(input.request);
      const backup = await repository.exportBackupBundle?.(document);
      if (!backup) {
        throw new Error('CRDT document does not exist.');
      }

      const reason = readReason(body, 'api-v1-admin-operations-compaction');
      const snapshot = body.snapshot ??
        createRallarCrdtCompactedSnapshot({
          document,
          records: backup.records,
          reason,
          now: this.options.now,
        });
      assertCrdtSnapshotDocumentMatches(snapshot, document);
      await repository.writeSnapshot?.({
        snapshot,
        appendSequence: backup.metadata.lastAppendSequence,
        reason,
      });

      return {
        document,
        documentKey: backup.documentKey,
        appendSequence: backup.metadata.lastAppendSequence,
        snapshot: toRedactedCrdtSnapshotSummary(snapshot),
      };
    });
  }

  async updateCrdtLifecycle(
    input: AdminOperationsWriteInput<RallarCrdtLifecycleInput>,
  ): Promise<unknown> {
    if (this.options.mutationGateway) return await this.options.mutationGateway.updateCrdtLifecycle(input);
    return await this.timeWrite('crdt.lifecycle', input, async () => {
      const body = readObject(input.request);
      const lifecycle = readAdminCrdtLifecycle(body.lifecycle);
      return await this.requireCrdtRepository('updateDocumentLifecycle')
        .updateDocumentLifecycle({
          ...body,
          lifecycle,
          changedAtEpochMs: body.changedAtEpochMs ?? this.options.now(),
        } as RallarCrdtLifecycleInput);
    });
  }

  async eraseCrdt(input: AdminOperationsWriteInput<unknown>): Promise<unknown> {
    if (this.options.mutationGateway) return await this.options.mutationGateway.eraseCrdt(input);
    return await this.timeWrite('crdt.erase', input, async () => {
      const body = readObject(input.request) as {
        document?: RallarCrdtDocumentRef;
        requestedBy?: PrincipalId;
        reason?: string;
        mode?: RallarCrdtErasureRequest['mode'];
      };
      const document = readDocument(input.request);
      const mode = readAdminCrdtErasureMode(body.mode);
      const reason = readReason(body, 'api-v1-admin-operations-erasure');
      const request: RallarCrdtErasureRequest = {
        document,
        requestedAtEpochMs: this.options.now(),
        requestedBy: body.requestedBy ?? input.adminSession.clientId as PrincipalId,
        reason,
        mode,
      };
      const auditEvent = createRallarCrdtErasureAuditEvent(request);
      await this.options.crdtAuditSink?.record(auditEvent);

      if (mode === 'redact-payloads') {
        const redactedBundle = await this.requireCrdtRepository('exportDebugBundle')
          .exportDebugBundle(document, {
            reason,
            redaction: {
              payloadsRedacted: true,
              reason,
            },
          });
        return { request, auditEvent, redactedBundle };
      }

      const metadata = await this.requireCrdtRepository('updateDocumentLifecycle')
        .updateDocumentLifecycle({
          document,
          lifecycle: 'destroyed',
          changedAtEpochMs: request.requestedAtEpochMs,
        });

      return { request, auditEvent, metadata };
    });
  }

  private async timeWrite<T>(
    operation: string,
    input: AdminOperationsWriteInput<unknown>,
    action: () => Promise<T>,
  ): Promise<T> {
    const timingInput = this.createWriteTimingInput(operation, input);
    const startedAt = nowMs();

    try {
      const result = await action();
      recordRallarTiming(
        this.options.timing,
        {
          ...timingInput,
          details: {
            ...timingInput.details,
            ...readResultTimingDetails(result),
          },
        },
        'ok',
        nowMs() - startedAt,
      );
      return result;
    } catch (error) {
      recordRallarTiming(
        this.options.timing,
        timingInput,
        'error',
        nowMs() - startedAt,
        error,
      );
      throw error;
    }
  }

  private createWriteTimingInput(
    operation: string,
    input: AdminOperationsWriteInput<unknown>,
  ): RallarTimingEventInput {
    const request = readObject(input.request);
    const target = readTimingTarget(input.request);

    return {
      component: 'admin-operations',
      operation,
      serviceId: this.options.serverId,
      requestId: readTimingString(request.requestId),
      applicationId: target.applicationId,
      workspaceId: target.workspaceId,
      groupId: target.groupId,
      principalId: input.adminSession.clientId,
      sessionId: input.adminSession.sessionId,
      details: compactTimingDetails({
        adminClientId: input.adminSession.clientId,
        reason: readTimingString(request.reason),
        dryRun: readTimingBoolean(request.dryRun),
        categories: readTimingStringList(request.categories),
        mode: readTimingString(request.mode),
        documentScope: target.documentScope,
        documentType: target.documentType,
        documentId: target.documentId,
      }),
    };
  }

  private base(
    scope?: StateScope,
    warnings: readonly AdminOperationWarning[] = [],
  ): AdminOperationBaseResponse {
    return {
      generatedAtEpochMs: this.options.now(),
      serverId: this.options.serverId,
      scope,
      warnings,
    };
  }

  private requireCrdtRepository<K extends keyof RallarCrdtAdminLogRepository>(
    method: K,
  ): Partial<RallarCrdtAdminLogRepository> & Pick<RallarCrdtAdminLogRepository, K> {
    const repository = this.options.crdtAdminRepository;
    if (!repository || typeof repository[method] !== 'function') {
      throw new Error(`CRDT admin repository does not support ${String(method)}.`);
    }
    return repository as
      & Partial<RallarCrdtAdminLogRepository>
      & Pick<RallarCrdtAdminLogRepository, K>;
  }
}

function readObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? input as Record<string, unknown> : {};
}

function readRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined;
}

function readDocument(input: unknown): RallarCrdtDocumentRef {
  const body = readObject(input);
  const document = body.document ?? input;
  if (!document || typeof document !== 'object') {
    throw new Error('CRDT admin operation requires a document ref.');
  }
  return document as RallarCrdtDocumentRef;
}

function assertCrdtSnapshotDocumentMatches(
  snapshot: RallarCrdtSnapshotEnvelope,
  document: RallarCrdtDocumentRef,
): void {
  if (!isSameCrdtDocumentRef(snapshot.document, document)) {
    throw new Error('CRDT compact snapshot document must match the requested document.');
  }
}

function isSameCrdtDocumentRef(
  left: RallarCrdtDocumentRef,
  right: RallarCrdtDocumentRef,
): boolean {
  return left.applicationId === right.applicationId &&
    left.workspaceId === right.workspaceId &&
    readCrdtDocumentScope(left) === readCrdtDocumentScope(right) &&
    left.documentType === right.documentType &&
    left.documentId === right.documentId &&
    left.principalId === right.principalId &&
    left.customScope === right.customScope &&
    isSameOptionalGroupRef(left.roomRef, right.roomRef);
}

function readCrdtDocumentScope(document: RallarCrdtDocumentRef): string | undefined {
  const record = document as unknown as Record<string, unknown>;
  return readCrdtString(record.scope) ?? readCrdtString(record.documentScope);
}

function isSameOptionalGroupRef(
  left: RallarCrdtDocumentRef['roomRef'],
  right: RallarCrdtDocumentRef['roomRef'],
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return left.applicationId === right.applicationId &&
    left.workspaceId === right.workspaceId &&
    left.groupId === right.groupId;
}

function readCrdtString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readReason(input: AdminOperationRequest, fallback: string): string {
  return typeof input.reason === 'string' && input.reason.trim().length > 0
    ? input.reason
    : fallback;
}

function readMetricsResetCategories(value: unknown): readonly AdminMetricsResetCategory[] {
  return readAdminCategoryList(
    value,
    ADMIN_METRICS_RESET_CATEGORIES,
    ADMIN_METRICS_RESET_CATEGORIES,
    'Admin metrics reset categories',
    'admin metrics reset category',
  );
}

function readPruneExpiredCategories(value: unknown): readonly AdminPruneExpiredCategory[] {
  return readAdminCategoryList(
    value,
    ADMIN_PRUNE_EXPIRED_CATEGORIES.filter((category) => category !== 'app-data'),
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    'Admin prune-expired categories',
    'admin prune-expired category',
  );
}

function readAdminCategoryList<TCategory extends string>(
  value: unknown,
  fallback: readonly TCategory[],
  allowed: readonly TCategory[],
  fieldLabel: string,
  itemLabel: string,
): readonly TCategory[] {
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldLabel} must be an array.`);
  }

  const allowedSet = new Set<string>(allowed);
  return value.map((item) => {
    if (typeof item !== 'string' || !allowedSet.has(item)) {
      throw new Error(`Unsupported ${itemLabel}: ${String(item)}`);
    }
    return item as TCategory;
  });
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function readAppDataPruneOptions(value: unknown): AdminPruneExpiredOptions['appData'] {
  if (value === undefined) {
    return undefined;
  }
  const object = readRecord(value);
  if (!object) {
    throw new Error('appData must be an object.');
  }
  return {
    namespace: readOptionalStringField(object.namespace, 'appData.namespace'),
    storeName: readOptionalStringField(object.storeName, 'appData.storeName'),
  };
}

function readOptionalStringField(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readChanged(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('changed' in value)) {
    return false;
  }
  return (value as { changed?: unknown }).changed === true;
}

function toRedactedCrdtSnapshotSummary(
  snapshot: RallarCrdtSnapshotEnvelope,
): Readonly<Record<string, unknown>> {
  return compactResponseObject({
    protocolVersion: snapshot.protocolVersion,
    document: snapshot.document,
    snapshotId: snapshot.snapshotId,
    schemaVersion: snapshot.schemaVersion,
    createdAtEpochMs: snapshot.createdAtEpochMs,
    maxLamport: snapshot.maxLamport,
    includedUpdateCount: snapshot.includedUpdateIds.length,
    updateCount: snapshot.metadata.updateCount,
    tombstoneCount: snapshot.metadata.tombstoneCount,
    conflictCount: snapshot.metadata.conflictCount,
    reason: snapshot.metadata.reason,
    hash: snapshot.hash,
    valueRedacted: true,
    stateMetadataRedacted: snapshot.metadata.crdtState || snapshot.metadata.sequenceState
      ? true
      : undefined,
  });
}

function readResultTimingDetails(result: unknown): RallarTimingDetails {
  const body = readObject(result);
  return compactTimingDetails({
    operationStatus: readTimingString(body.status),
    changed: readTimingBoolean(body.changed),
  });
}

function readTimingTarget(input: unknown): Readonly<{
  applicationId?: string;
  workspaceId?: string;
  groupId?: string;
  documentScope?: string;
  documentType?: string;
  documentId?: string;
}> {
  const body = readObject(input);
  const groupRef = readRecord(body.groupRef);
  const directDocument = readTimingString(body.documentId) ? body : undefined;
  const document = readRecord(body.document) ?? directDocument;
  const roomRef = readRecord(document?.roomRef);

  return {
    applicationId: readTimingString(groupRef?.applicationId) ??
      readTimingString(document?.applicationId) ??
      readTimingString(body.applicationId),
    workspaceId: readTimingString(groupRef?.workspaceId) ??
      readTimingString(document?.workspaceId) ??
      readTimingString(body.workspaceId),
    groupId: readTimingString(groupRef?.groupId) ??
      readTimingString(roomRef?.groupId) ??
      readTimingString(body.groupId),
    documentScope: readTimingString(document?.scope) ??
      readTimingString(document?.documentScope),
    documentType: readTimingString(document?.documentType),
    documentId: readTimingString(document?.documentId),
  };
}

function readTimingString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readTimingBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readTimingStringList(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .map((item) => readTimingString(item))
    .filter((item): item is string => item !== undefined);
  return strings.length > 0 ? strings.join(',') : undefined;
}

function compactTimingDetails(details: RallarTimingDetails): RallarTimingDetails {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  ) as RallarTimingDetails;
}

function compactResponseObject(input: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
