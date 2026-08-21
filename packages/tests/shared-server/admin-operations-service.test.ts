import { describe, expect, it } from 'vitest';

import type {
  AdminOperationsCrdtResponse,
  AdminOperationsQueuesResponse,
  AdminOperationsStateResponse,
  AdminOperationsSystemResponse,
} from '@shared/api/admin-operations-types.ts';
import type { RallarCrdtDocumentMetadata, RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

import type {
  AdminOperationsMutationGateway,
} from '@shared-server/rallar-system/admin-operations/admin-operations-mutation-gateway.ts';
import { AdminOperationsService } from '@shared-server/rallar-system/admin-operations/AdminOperationsService.ts';
import type {
  AdminPruneEnqueueResult,
} from '@shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts';
import type {
  CrdtAdminCompactResult,
  CrdtAdminEraseResult,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { emptyGroupFormationMetrics } from '@shared-server/rallar-system/formation-metrics.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';

import type {
  TopologyReconfigureInboxResult,
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const CRDT_DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'map',
  documentId: 'doc-1',
};
const CRDT_METADATA: RallarCrdtDocumentMetadata = {
  document: CRDT_DOCUMENT,
  documentKey: 'app-1/workspace-1/room/map/doc-1',
  documentRevision: 1,
  lifecycle: 'active',
  createdAtEpochMs: NOW_EPOCH_MS,
  updatedAtEpochMs: NOW_EPOCH_MS,
  archivedAtEpochMs: null,
  destroyedAtEpochMs: null,
  lastAppendSequence: 0,
  updateCount: 0,
  snapshotCount: 1,
  storedUpdateBytes: 0,
  retention: null,
  quota: null,
  projectionIds: [],
};
const PRUNE_RESULT: AdminPruneEnqueueResult = {
  generatedAtEpochMs: NOW_EPOCH_MS,
  serverId: 'test-server',
  warnings: [],
  operation: 'maintenance.prune-expired',
  status: 'completed',
  changed: true,
  jobId: 'prune-1',
  results: [],
};
const TOPOLOGY_RESULT: TopologyReconfigureInboxResult = {
  status: 'queued',
  groupRef: {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
  },
  requestId: 'topology-1',
  outboxId: 'topology-outbox-1',
};
const CRDT_COMPACT_RESULT: CrdtAdminCompactResult = {
  document: CRDT_DOCUMENT,
  documentKey: CRDT_METADATA.documentKey,
  appendSequence: 0,
  snapshot: {
    protocolVersion: 1,
    document: CRDT_DOCUMENT,
    snapshotId: 'snapshot-1',
    schemaVersion: 1,
    createdAtEpochMs: NOW_EPOCH_MS,
    maxLamport: 0,
    includedUpdateIds: [],
    value: null,
    metadata: { updateCount: 0, reason: 'test' },
  },
};
const CRDT_ERASE_RESULT: CrdtAdminEraseResult = {
  request: {
    document: CRDT_DOCUMENT,
    requestedAtEpochMs: NOW_EPOCH_MS,
    requestedBy: 'platform-admin',
    reason: 'test',
    mode: 'destroy-document',
  },
  auditEvent: {
    kind: 'erase',
    atEpochMs: NOW_EPOCH_MS,
  },
  metadata: CRDT_METADATA,
};

describe('AdminOperationsService', () => {
  it('composes overview from read sources and process-local realtime status', async () => {
    const overview = await createService().readOverview({
      adminSession: createAdminSession(),
    });

    expect(overview).toMatchObject({
      generatedAtEpochMs: NOW_EPOCH_MS,
      serverId: 'test-server',
      health: { status: 'ok' },
      websocket: { connectionCount: 2, openConnectionCount: 1 },
      queues: { queuedRows: 4, resultRows: 3, expiredRows: 3 },
      state: { activeSessions: 2, activeGroups: 1 },
      crdt: { documents: 5, updates: 8, snapshots: 2, storedUpdateBytes: 128 },
      system: { runtimeStateRows: 9, appDataRows: 7 },
    });
  });

  it('resets only requested process-local metrics', async () => {
    const calls: string[] = [];
    let metrics = { recomputeCount: 2 };
    const service = createService({
      readRtcTopologyMetrics: () => metrics,
      resetRtcTopologyMetrics: () => {
        calls.push('reset');
        metrics = { recomputeCount: 0 };
      },
    });

    const result = await service.resetMetrics({
      adminSession: createAdminSession(),
      request: { categories: ['rtc-topology'], reason: 'operator-test' },
    });

    expect(calls).toEqual(['reset']);
    expect(result).toMatchObject({
      operation: 'metrics.reset',
      status: 'completed',
      changed: true,
      before: { rtcTopology: { recomputeCount: 2 } },
      after: { rtcTopology: { recomputeCount: 0 } },
    });
  });

  it('exposes group-formation metrics beside rtc-topology in realtime and overview', async () => {
    const formationMetrics = {
      ...emptyGroupFormationMetrics(),
      presenceSummaryExpansionCount: 4,
    };
    const service = createService({
      readGroupFormationMetrics: () => formationMetrics,
    });

    const realtime = await service.readRealtime({ adminSession: createAdminSession() });
    expect(realtime.rtcTopology).toEqual({
      metrics: { recomputeCount: 0 },
      processLocal: true,
    });
    expect(realtime.groupFormation).toEqual({
      metrics: formationMetrics,
      processLocal: true,
    });

    const overview = await service.readOverview({ adminSession: createAdminSession() });
    expect(overview.realtime).toEqual({
      topologyMetrics: { recomputeCount: 0 },
      groupFormationMetrics: formationMetrics,
    });
  });

  it('resets group-formation metrics without touching rtc-topology metrics', async () => {
    const calls: string[] = [];
    let formationMetrics = {
      ...emptyGroupFormationMetrics(),
      presenceSummaryExpansionCount: 4,
    };
    const service = createService({
      readRtcTopologyMetrics: () => ({ recomputeCount: 2 }),
      resetRtcTopologyMetrics: () => {
        calls.push('reset-rtc-topology');
      },
      readGroupFormationMetrics: () => formationMetrics,
      resetGroupFormationMetrics: () => {
        calls.push('reset-group-formation');
        formationMetrics = emptyGroupFormationMetrics();
      },
    });

    const result = await service.resetMetrics({
      adminSession: createAdminSession(),
      request: { categories: ['group-formation'], reason: 'operator-test' },
    });

    expect(calls).toEqual(['reset-group-formation']);
    expect(result).toMatchObject({
      operation: 'metrics.reset',
      status: 'completed',
      changed: true,
      before: { groupFormation: { presenceSummaryExpansionCount: 4 } },
      after: { groupFormation: { presenceSummaryExpansionCount: 0 } },
    });
  });

  it('records bounded timing metadata for process-local metric writes', async () => {
    const events: RallarTimingEvent[] = [];
    const service = createService({ timing: (event) => events.push(event) });

    await service.resetMetrics({
      adminSession: createAdminSession(),
      request: {
        requestId: 'reset-1',
        categories: ['rtc-topology'],
        reason: 'operator-test',
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      component: 'admin-operations',
      operation: 'metrics.reset',
      status: 'ok',
      requestId: 'reset-1',
      principalId: 'platform-admin',
      sessionId: 'admin-session',
    });
    expect(JSON.stringify(events[0])).not.toContain('access-token');
  });

  it('routes prune-expired through the mandatory mutation gateway unchanged', async () => {
    const calls: unknown[] = [];
    const mutationGateway = createMutationGateway({
      pruneExpired: (input) => {
        calls.push(input);
        return Promise.resolve(PRUNE_RESULT);
      },
    });
    const service = createService({ mutationGateway });
    const input = {
      adminSession: createAdminSession(),
      requestId: 'prune-expired-request',
      request: {
        dryRun: false,
        categories: ['runtime-state', 'resource-inbox-results'] as const,
      },
    };

    await expect(service.pruneExpired(input)).resolves.toMatchObject({
      status: 'completed',
      changed: true,
    });
    expect(calls).toEqual([input]);
  });

  it('validates process-local metric categories before resetting', async () => {
    await expect(
      createService().resetMetrics({
        adminSession: createAdminSession(),
        request: { categories: 'rtc-topology' as never },
      }),
    ).rejects.toThrow(/must be an array/);
  });

  it('routes topology recompute through the mandatory mutation gateway unchanged', async () => {
    const calls: unknown[] = [];
    const mutationGateway = createMutationGateway({
      recomputeTopology: (input) => {
        calls.push(input);
        return Promise.resolve(TOPOLOGY_RESULT);
      },
    });
    const service = createService({ mutationGateway });
    const input = {
      adminSession: createAdminSession(),
      requestId: 'topology-1',
      request: {
        groupRef: {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          groupId: 'room-1',
        },
        options: { topologyKind: 'tree' as const },
      },
    };

    await expect(service.recomputeTopology(input)).resolves.toMatchObject({
      status: 'queued',
      requestId: 'topology-1',
      outboxId: 'topology-outbox-1',
    });
    expect(calls).toEqual([input]);
  });

  it('routes every CRDT mutation through the mandatory gateway unchanged', async () => {
    const calls: Array<readonly [string, object]> = [];
    const mutationGateway = createMutationGateway({
      compactCrdt: (input) => record(calls, 'compact', input, CRDT_COMPACT_RESULT),
      updateCrdtLifecycle: (input) => record(calls, 'lifecycle', input, CRDT_METADATA),
      eraseCrdt: (input) => record(calls, 'erase', input, CRDT_ERASE_RESULT),
    });
    const service = createService({ mutationGateway });
    const adminSession = createAdminSession();
    const compact = {
      adminSession,
      requestId: 'compact-request',
      request: { document: CRDT_DOCUMENT },
    };
    const lifecycle = {
      adminSession,
      requestId: 'lifecycle-request',
      request: { document: CRDT_DOCUMENT, lifecycle: 'archived' as const },
    };
    const erase = {
      adminSession,
      requestId: 'erase-request',
      request: { document: CRDT_DOCUMENT, mode: 'full' },
    };

    await service.compactCrdt(compact);
    await service.updateCrdtLifecycle(lifecycle);
    await service.eraseCrdt(erase);

    expect(calls).toEqual([
      ['compact', compact],
      ['lifecycle', lifecycle],
      ['erase', erase],
    ]);
  });

  it('keeps CRDT debug export read-only and redacted by default', async () => {
    const calls: unknown[] = [];
    const service = createService({
      crdtAdminRepository: {
        exportDebugBundle: (document, options) => {
          calls.push({ document, options });
          return Promise.resolve({
            format: 'rallar.crdt.debug-bundle.v1',
            exportedAtEpochMs: NOW_EPOCH_MS,
            reason: 'api-v1-admin-operations-debug-export',
            document,
            documentKey: 'app-1/workspace-1/room/map/doc-1',
            records: [],
            redaction: { payloadsRedacted: true },
            integrity: {
              bundleHash: `sha256:${'a'.repeat(64)}`,
              documentRefHash: `sha256:${'b'.repeat(64)}`,
              updateHashes: {},
              updateCount: 0,
              sequenceGaps: [],
            },
          });
        },
      },
    });

    const result = await service.exportCrdtDebug({
      adminSession: createAdminSession(),
      request: { document: CRDT_DOCUMENT },
    });

    expect(calls).toEqual([
      {
        document: CRDT_DOCUMENT,
        options: {
          reason: 'api-v1-admin-operations-debug-export',
          redaction: {
            payloadsRedacted: true,
            reason: 'api-v1-admin-operations-redaction',
          },
        },
      },
    ]);
    expect(result).toMatchObject({
      document: CRDT_DOCUMENT,
      redaction: { payloadsRedacted: true },
    });
  });
});

function createService(overrides: Partial<ConstructorParameters<typeof AdminOperationsService>[0]> = {}): AdminOperationsService {
  return new AdminOperationsService({
    now: () => NOW_EPOCH_MS,
    serverId: 'test-server',
    statsReader: new FakeStatsReader(),
    wsStatus: () => ({
      connectionCount: 2,
      openConnectionCount: 1,
      connectionIds: ['closed-1', 'open-1'],
      openConnectionIds: ['open-1'],
      connections: [],
    }),
    readRtcTopologyMetrics: () => ({ recomputeCount: 0 }),
    resetRtcTopologyMetrics: () => undefined,
    mutationGateway: createMutationGateway(),
    ...overrides,
  });
}

function createMutationGateway(overrides: Partial<AdminOperationsMutationGateway> = {}): AdminOperationsMutationGateway {
  return {
    recomputeTopology: () => Promise.resolve(TOPOLOGY_RESULT),
    pruneExpired: () => Promise.resolve(PRUNE_RESULT),
    compactCrdt: () => Promise.resolve(CRDT_COMPACT_RESULT),
    updateCrdtLifecycle: () => Promise.resolve(CRDT_METADATA),
    eraseCrdt: () => Promise.resolve(CRDT_ERASE_RESULT),
    ...overrides,
  };
}

function record<TInput extends object, TResult>(
  calls: Array<readonly [string, object]>,
  operation: string,
  input: TInput,
  result: TResult,
): Promise<TResult> {
  calls.push([operation, input]);
  return Promise.resolve(result);
}

function createAdminSession() {
  return {
    clientId: 'platform-admin',
    username: 'admin',
    accessToken: 'access-token',
    sessionId: 'admin-session',
    expiresAtEpochMs: NOW_EPOCH_MS + 60_000,
  };
}

class FakeStatsReader {
  readQueues(): Promise<AdminOperationsQueuesResponse> {
    return Promise.resolve({
      generatedAtEpochMs: NOW_EPOCH_MS,
      serverId: 'test-server',
      warnings: [],
      queueRows: { total: 4, expired: 2, byTypeStatus: [], topPressure: [] },
      resultRows: { total: 3, expired: 1, byTypeStatus: [], topPressure: [] },
    });
  }

  readState(): Promise<AdminOperationsStateResponse> {
    return Promise.resolve({
      generatedAtEpochMs: NOW_EPOCH_MS,
      serverId: 'test-server',
      warnings: [],
      clients: { totalPrincipals: 3, onlinePrincipals: 1, activeSessions: 2 },
      groups: { activeGroups: 1, totalActiveMembers: 4, onlineMembers: 2 },
      events: { recentClientEvents: 6, recentGroupEvents: 7 },
    });
  }

  readCrdt(): Promise<AdminOperationsCrdtResponse> {
    return Promise.resolve({
      generatedAtEpochMs: NOW_EPOCH_MS,
      serverId: 'test-server',
      warnings: [],
      documents: { total: 5, byLifecycle: [], byScopeType: [] },
      storage: { updates: 8, snapshots: 2, storedUpdateBytes: 128 },
    });
  }

  readSystem(): Promise<AdminOperationsSystemResponse> {
    return Promise.resolve({
      generatedAtEpochMs: NOW_EPOCH_MS,
      serverId: 'test-server',
      warnings: [],
      runtimeState: { rows: 9, expiredRows: 2, byNamespace: [] },
      appData: { rows: 7, expiredRows: 1, byNamespaceStore: [] },
      stateEvents: { clientEvents: 6, groupEvents: 7 },
      configuration: { sqlBackend: 'pglite-memory' },
    });
  }
}
