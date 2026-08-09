import type { AuthSession } from '@shared/api/api-config.ts';
import type {
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
import type { StateScope } from '@shared/api/state-types.ts';
import type { RallarGroupFormationMetrics } from '@shared/rtc/group-formation-metrics.ts';
import {
  type RallarCrdtAdminLogRepository,
  type RallarCrdtLifecycleInput,
} from '@shared/crdt/mod.ts';
import {
  nowMs,
  type RallarTimingEventInput,
  type RallarTimingSink,
  recordRallarTiming,
} from '../services/timing.ts';
import type { AdminOperationsMutationGateway } from './admin-operations-mutation-gateway.ts';
import type { AdminPruneExpiredOptions } from './admin-prune-options.ts';
import {
  compactTimingDetails,
  readDocument,
  readMetricsResetCategories,
  readObject,
  readReason,
  readResultTimingDetails,
  readTimingBoolean,
  readTimingString,
  readTimingStringList,
  readTimingTarget,
} from './admin-operations-request-reading.ts';
export type { AdminPruneExpiredOptions } from './admin-prune-options.ts';
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
export type AdminOperationsTopologyManagement = Readonly<{
  reconfigureGroupTopology(input: unknown): Promise<unknown>;
}>;
export type AdminOperationsServiceOptions = Readonly<{
  now: () => number;
  serverId?: string;
  statsReader: AdminOperationsStatsReader;
  wsStatus?: () => AdminRealtimeWsStatus;
  readRtcTopologyMetrics?: () => unknown;
  resetRtcTopologyMetrics?: () => void;
  readGroupFormationMetrics?: () => RallarGroupFormationMetrics;
  resetGroupFormationMetrics?: () => void;
  crdtAdminRepository?: Partial<RallarCrdtAdminLogRepository>;
  timing?: RallarTimingSink;
  mutationGateway: AdminOperationsMutationGateway;
}>;

export type AdminRealtimeWsStatus = Readonly<{
  connectionCount: number;
  openConnectionCount: number;
  connectionIds: readonly string[];
  openConnectionIds: readonly string[];
  connections?: readonly unknown[];
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
        groupFormationMetrics: realtime.groupFormation.metrics,
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

  readRealtime(input: AdminOperationsReadInput): Promise<AdminOperationsRealtimeResponse> {
    const status = this.options.wsStatus?.() ?? {
      connectionCount: 0,
      openConnectionCount: 0,
      connectionIds: [],
      openConnectionIds: [],
    };
    return Promise.resolve({
      ...this.base(input.scope, [
        {
          code: 'process-local-realtime',
          message: 'Realtime metrics are process-local in multi-server deployments.',
          source: 'ws',
        },
      ]),
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
      groupFormation: {
        metrics: this.options.readGroupFormationMetrics?.(),
        processLocal: true,
      },
    });
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
    return await this.timeWrite('metrics.reset', input, () => {
      const request = readObject(input.request);
      const categories = readMetricsResetCategories(request.categories);
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      let changed = false;

      for (const category of categories) {
        if (category === 'rtc-topology') {
          before.rtcTopology = this.options.readRtcTopologyMetrics?.();
          this.options.resetRtcTopologyMetrics?.();
          after.rtcTopology = this.options.readRtcTopologyMetrics?.();
          changed = true;
        }
        if (category === 'group-formation') {
          before.groupFormation = this.options.readGroupFormationMetrics?.();
          this.options.resetGroupFormationMetrics?.();
          after.groupFormation = this.options.readGroupFormationMetrics?.();
          changed = true;
        }
      }

      return Promise.resolve({
        ...this.base(),
        operation: 'metrics.reset',
        status: 'completed',
        changed,
        before,
        after,
      });
    });
  }

  async recomputeTopology(
    input: AdminOperationsWriteInput<AdminTopologyRecomputeRequest>,
  ): Promise<AdminOperationResultResponse> {
    return (await this.options.mutationGateway.recomputeTopology(
      input,
    )) as AdminOperationResultResponse;
  }

  async pruneExpired(
    input: AdminOperationsWriteInput<AdminPruneExpiredRequest>,
  ): Promise<AdminOperationResultResponse> {
    return (await this.options.mutationGateway.pruneExpired(
      input,
    )) as AdminOperationResultResponse;
  }

  async verifyCrdtIntegrity(input: AdminOperationsWriteInput<unknown>): Promise<unknown> {
    return await this.timeWrite(
      'crdt.integrity',
      input,
      async () =>
        await this.requireCrdtRepository('verifyIntegrity').verifyIntegrity(
          readDocument(input.request),
        ),
    );
  }

  async exportCrdtDebug(input: AdminOperationsWriteInput<unknown>): Promise<unknown> {
    return await this.timeWrite('crdt.debug-export', input, async () => {
      const body = readObject(input.request);
      const redactPayloads = body.redactPayloads === false ? false : true;
      return await this.requireCrdtRepository('exportDebugBundle').exportDebugBundle(
        readDocument(input.request),
        {
          reason: readReason(body, 'api-v1-admin-operations-debug-export'),
          redaction: redactPayloads
            ? {
              payloadsRedacted: true,
              reason: 'api-v1-admin-operations-redaction',
            }
            : { payloadsRedacted: false },
        },
      );
    });
  }

  async compactCrdt(input: AdminOperationsWriteInput<unknown>): Promise<unknown> {
    return await this.options.mutationGateway.compactCrdt(input);
  }

  async updateCrdtLifecycle(
    input: AdminOperationsWriteInput<RallarCrdtLifecycleInput>,
  ): Promise<unknown> {
    return await this.options.mutationGateway.updateCrdtLifecycle(input);
  }

  async eraseCrdt(input: AdminOperationsWriteInput<unknown>): Promise<unknown> {
    return await this.options.mutationGateway.eraseCrdt(input);
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
