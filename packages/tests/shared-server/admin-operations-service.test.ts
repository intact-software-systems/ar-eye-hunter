import { describe, expect, it } from 'vitest';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import type {
  AdminOperationsCrdtResponse,
  AdminOperationsQueuesResponse,
  AdminOperationsStateResponse,
  AdminOperationsSystemResponse,
} from '@shared/api/admin-operations-types.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { AdminOperationsService } from '@shared-server/rallar-system/admin-operations/AdminOperationsService.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const CRDT_DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  documentScope: 'group',
  documentType: 'map',
  documentId: 'doc-1',
};

describe('AdminOperationsService', () => {
  it('composes overview from read sources and process-local realtime status', async () => {
    const service = createService();

    const overview = await service.readOverview({
      adminSession: createAdminSession(),
    });

    expect(overview).toMatchObject({
      generatedAtEpochMs: NOW_EPOCH_MS,
      serverId: 'test-server',
      health: { status: 'ok' },
      websocket: {
        connectionCount: 2,
        openConnectionCount: 1,
      },
      queues: {
        queuedRows: 4,
        resultRows: 3,
        expiredRows: 3,
      },
      state: {
        activeSessions: 2,
        activeGroups: 1,
      },
      crdt: {
        documents: 5,
        updates: 8,
        snapshots: 2,
        storedUpdateBytes: 128,
      },
      system: {
        runtimeStateRows: 9,
        appDataRows: 7,
      },
    });
  });

  it('resets only requested resettable metrics and reports before and after values', async () => {
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
      request: {
        categories: ['rtc-topology'],
        reason: 'operator-test',
      },
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

  it('records bounded timing metadata for write operations without leaking tokens', async () => {
    const events: RallarTimingEvent[] = [];
    let metrics = { recomputeCount: 2 };
    const service = createService({
      timing: (event) => events.push(event),
      readRtcTopologyMetrics: () => metrics,
      resetRtcTopologyMetrics: () => {
        metrics = { recomputeCount: 0 };
      },
    });

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
      type: 'rallar.timing',
      component: 'admin-operations',
      operation: 'metrics.reset',
      status: 'ok',
      serviceId: 'test-server',
      requestId: 'reset-1',
      principalId: 'platform-admin',
      sessionId: 'admin-session',
      details: {
        adminClientId: 'platform-admin',
        reason: 'operator-test',
        categories: 'rtc-topology',
        operationStatus: 'completed',
        changed: true,
      },
    });
    expect(events[0]?.durationMs).toEqual(expect.any(Number));
    expect(events[0]?.atEpochMs).toEqual(expect.any(Number));
    expect(JSON.stringify(events[0])).not.toContain('access-token');
  });

  it('defaults prune-expired to dry-run and requires app-data namespace for facade pruning', async () => {
    const pruner = new FakePruner();
    const service = createService({ pruner });

    const dryRun = await service.pruneExpired({
      adminSession: createAdminSession(),
      request: {
        categories: ['runtime-state', 'app-data'],
        appData: {
          namespace: 'rallar-tests',
        },
      },
    });

    expect(pruner.calls).toEqual([]);
    expect(dryRun).toMatchObject({
      operation: 'maintenance.prune-expired',
      status: 'dry-run',
      changed: false,
      results: [
        { category: 'runtime-state', expiredRows: 2, deletedRows: 0 },
        { category: 'app-data', expiredRows: 1, deletedRows: 0 },
      ],
    });

    await expect(service.pruneExpired({
      adminSession: createAdminSession(),
      request: {
        dryRun: false,
        categories: ['app-data'],
      },
    })).rejects.toThrow(/appData.namespace is required/);
  });

  it('prunes expired rows when dryRun is false', async () => {
    const pruner = new FakePruner();
    const service = createService({ pruner });

    const result = await service.pruneExpired({
      adminSession: createAdminSession(),
      request: {
        dryRun: false,
        categories: ['runtime-state', 'resource-inbox-results'],
      },
    });

    expect(pruner.calls).toEqual(['runtime-state', 'resource-inbox-results']);
    expect(result).toMatchObject({
      status: 'completed',
      changed: true,
      results: [
        { category: 'runtime-state', expiredRows: 2, deletedRows: 2 },
        { category: 'resource-inbox-results', expiredRows: 4, deletedRows: 4 },
      ],
    });
  });

  it('rejects invalid write category lists before executing maintenance operations', async () => {
    const pruner = new FakePruner();
    const service = createService({ pruner });

    await expect(service.pruneExpired({
      adminSession: createAdminSession(),
      request: {
        dryRun: false,
        categories: ['runtime-state', 'everything'] as never,
      },
    })).rejects.toThrow(/Unsupported admin prune-expired category: everything/);
    expect(pruner.calls).toEqual([]);

    await expect(service.resetMetrics({
      adminSession: createAdminSession(),
      request: {
        categories: 'rtc-topology' as never,
      },
    })).rejects.toThrow(/Admin metrics reset categories must be an array/);
  });

  it('delegates topology recompute with request options and publish default', async () => {
    const calls: unknown[] = [];
    const service = createService({
      topologyManagement: {
        reconfigureGroupTopology: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({
            changed: true,
            published: true,
            snapshot: { version: 2 },
          });
        },
      },
    });

    const result = await service.recomputeTopology({
      adminSession: createAdminSession(),
      request: {
        requestId: 'topology-1',
        groupRef: {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          groupId: 'room-1',
        },
        options: { topologyKind: 'tree' },
      },
    });

    expect(calls).toEqual([
      {
        groupRef: {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          groupId: 'room-1',
        },
        requestOptions: { topologyKind: 'tree' },
        publish: true,
        requestId: 'topology-1',
      },
    ]);
    expect(result).toMatchObject({
      operation: 'topology.recompute',
      status: 'completed',
      changed: true,
      after: {
        changed: true,
        published: true,
      },
    });
  });

  it('redacts CRDT compact snapshot payloads from the admin operations response', async () => {
    const document: RallarCrdtDocumentRef = {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      documentScope: 'group',
      documentType: 'map',
      documentId: 'doc-1',
    };
    const suppliedSnapshot = {
      protocolVersion: 1 as const,
      document,
      snapshotId: 'snapshot-1',
      schemaVersion: 1,
      createdAtEpochMs: NOW_EPOCH_MS,
      maxLamport: 7,
      includedUpdateIds: ['update-1'],
      value: { secret: 'do-not-return' },
      metadata: {
        reason: 'operator-test',
      },
      hash: 'snapshot-hash',
    };
    const service = createService({
      crdtAdminRepository: {
        exportBackupBundle: () =>
          Promise.resolve({
            document,
            documentKey: 'doc-key-1',
            metadata: { lastAppendSequence: 5 },
            records: [],
          }),
        writeSnapshot: () => Promise.resolve(undefined),
      },
    });

    const result = await service.compactCrdt({
      adminSession: createAdminSession(),
      request: {
        document,
        snapshot: suppliedSnapshot,
      },
    });

    expect(result).toMatchObject({
      document,
      documentKey: 'doc-key-1',
      appendSequence: 5,
      snapshot: {
        snapshotId: 'snapshot-1',
        valueRedacted: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('do-not-return');
  });

  it('rejects CRDT compact snapshots for a different document before writing', async () => {
    const document: RallarCrdtDocumentRef = {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      documentScope: 'group',
      documentType: 'map',
      documentId: 'doc-1',
    };
    const otherDocument: RallarCrdtDocumentRef = {
      ...document,
      documentId: 'doc-2',
    };
    const suppliedSnapshot = {
      protocolVersion: 1 as const,
      document: otherDocument,
      snapshotId: 'snapshot-1',
      schemaVersion: 1,
      createdAtEpochMs: NOW_EPOCH_MS,
      maxLamport: 7,
      includedUpdateIds: ['update-1'],
      value: {},
      metadata: {
        reason: 'operator-test',
      },
    };
    let writeCount = 0;
    const service = createService({
      crdtAdminRepository: {
        exportBackupBundle: () =>
          Promise.resolve({
            document,
            documentKey: 'doc-key-1',
            metadata: { lastAppendSequence: 5 },
            records: [],
          }),
        writeSnapshot: () => {
          writeCount += 1;
          return Promise.resolve(undefined);
        },
      },
    });

    await expect(service.compactCrdt({
      adminSession: createAdminSession(),
      request: {
        document,
        snapshot: suppliedSnapshot,
      },
    })).rejects.toThrow(/snapshot document must match/i);
    expect(writeCount).toBe(0);
  });

  it('rejects an invalid CRDT lifecycle before repository calls', async () => {
    const lifecycleCalls: unknown[] = [];
    const service = createService({
      crdtAdminRepository: {
        updateDocumentLifecycle: (input) => {
          lifecycleCalls.push(input);
          return Promise.resolve({} as never);
        },
      },
    });

    await expect(service.updateCrdtLifecycle({
      adminSession: createAdminSession(),
      request: { document: CRDT_DOCUMENT, lifecycle: 'destroy' } as never,
    })).rejects.toThrow('Unsupported CRDT lifecycle: destroy');

    expect(lifecycleCalls).toEqual([]);
  });

  it('rejects an invalid CRDT erasure mode before recording an audit event', async () => {
    const auditCalls: unknown[] = [];
    const service = createService({
      crdtAdminRepository: {
        updateDocumentLifecycle: () => Promise.resolve({} as never),
      },
      crdtAuditSink: { record: (event) => { auditCalls.push(event); } },
    });

    await expect(service.eraseCrdt({
      adminSession: createAdminSession(),
      request: { document: CRDT_DOCUMENT, mode: 'redact-payload' },
    })).rejects.toThrow('Unsupported CRDT erasure mode: redact-payload');

    expect(auditCalls).toEqual([]);
  });

  it('wraps CRDT debug export with redaction enabled by default', async () => {
    const calls: unknown[] = [];
    const service = createService({
      crdtAdminRepository: {
        exportDebugBundle: (document: RallarCrdtDocumentRef, options: unknown) => {
          calls.push({ document, options });
          return Promise.resolve({ document, payloadsRedacted: true });
        },
      },
    });

    const result = await service.exportCrdtDebug({
      adminSession: createAdminSession(),
      request: {
        document: {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          documentScope: 'group',
          documentType: 'map',
          documentId: 'doc-1',
        },
      },
    });

    expect(calls).toEqual([
      {
        document: {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          documentScope: 'group',
          documentType: 'map',
          documentId: 'doc-1',
        },
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
      document: {
        documentId: 'doc-1',
      },
      payloadsRedacted: true,
    });
  });
});

function createService(
  overrides: Partial<ConstructorParameters<typeof AdminOperationsService>[0]> = {},
): AdminOperationsService {
  return new AdminOperationsService({
    now: () => NOW_EPOCH_MS,
    serverId: 'test-server',
    statsReader: new FakeStatsReader(),
    pruner: new FakePruner(),
    wsStatus: () => ({
      connectionCount: 2,
      openConnectionCount: 1,
      connectionIds: ['closed-1', 'open-1'],
      openConnectionIds: ['open-1'],
      connections: [],
    }),
    readRtcTopologyMetrics: () => ({ recomputeCount: 0 }),
    resetRtcTopologyMetrics: () => undefined,
    ...overrides,
  });
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
      queueRows: {
        total: 4,
        expired: 2,
        byTypeStatus: [],
        topPressure: [],
      },
      resultRows: {
        total: 3,
        expired: 1,
        byTypeStatus: [],
        topPressure: [],
      },
    });
  }

  readState(): Promise<AdminOperationsStateResponse> {
    return Promise.resolve({
      generatedAtEpochMs: NOW_EPOCH_MS,
      serverId: 'test-server',
      warnings: [],
      clients: {
        totalPrincipals: 3,
        onlinePrincipals: 1,
        activeSessions: 2,
      },
      groups: {
        activeGroups: 1,
        totalActiveMembers: 4,
        onlineMembers: 2,
      },
      events: {
        recentClientEvents: 6,
        recentGroupEvents: 7,
      },
    });
  }

  readCrdt(): Promise<AdminOperationsCrdtResponse> {
    return Promise.resolve({
      generatedAtEpochMs: NOW_EPOCH_MS,
      serverId: 'test-server',
      warnings: [],
      documents: {
        total: 5,
        byLifecycle: [],
        byScopeType: [],
      },
      storage: {
        updates: 8,
        snapshots: 2,
        storedUpdateBytes: 128,
      },
    });
  }

  readSystem(): Promise<AdminOperationsSystemResponse> {
    return Promise.resolve({
      generatedAtEpochMs: NOW_EPOCH_MS,
      serverId: 'test-server',
      warnings: [],
      runtimeState: {
        rows: 9,
        expiredRows: 2,
        byNamespace: [],
      },
      appData: {
        rows: 7,
        expiredRows: 1,
        byNamespaceStore: [],
      },
      stateEvents: {
        clientEvents: 6,
        groupEvents: 7,
      },
      configuration: {
        sqlBackend: 'pglite-memory',
      },
    });
  }
}

class FakePruner {
  readonly calls: string[] = [];

  countExpired(category: string): Promise<number> {
    return Promise.resolve(this.expiredCount(category));
  }

  pruneExpired(category: string): Promise<number> {
    this.calls.push(category);
    return Promise.resolve(this.expiredCount(category));
  }

  private expiredCount(category: string): number {
    switch (category) {
      case 'runtime-state':
        return 2;
      case 'resource-inbox-results':
        return 4;
      case 'app-data':
        return 1;
      default:
        return 0;
    }
  }
}
