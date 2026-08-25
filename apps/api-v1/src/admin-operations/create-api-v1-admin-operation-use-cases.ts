import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AdminOperationUseCases } from '@shared-server/rallar-system/admin-operations/admin-operation-use-cases.ts';
import { ExportAdminCrdtDebug } from '@shared-server/rallar-system/admin-operations/export-admin-crdt-debug.ts';
import { PSqlAdminCrdtReader } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-crdt-reader.ts';
import { PSqlAdminQueueReader } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-queue-reader.ts';
import { PSqlAdminStateReader } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-state-reader.ts';
import { PSqlAdminSystemReader } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-system-reader.ts';
import { ReadAdminOverview } from '@shared-server/rallar-system/admin-operations/read-admin-overview.ts';
import { ReadAdminRealtime } from '@shared-server/rallar-system/admin-operations/read-admin-realtime.ts';
import { ResetAdminMetrics } from '@shared-server/rallar-system/admin-operations/reset-admin-metrics.ts';
import { VerifyAdminCrdtIntegrity } from '@shared-server/rallar-system/admin-operations/verify-admin-crdt-integrity.ts';
import type { RallarGroupFormationMetricsRecorder } from '@shared-server/rallar-system/observability/formation-metrics.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { RallarServerWsStatus } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-status.ts';
import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';

import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';
import { CompactApiAdminCrdt } from './compact-api-admin-crdt.ts';
import { EraseApiAdminCrdt } from './erase-api-admin-crdt.ts';
import { PruneApiAdminExpiredData } from './prune-api-admin-expired-data.ts';
import { RecomputeApiAdminTopology } from './recompute-api-admin-topology.ts';
import { UpdateApiAdminCrdtLifecycle } from './update-api-admin-crdt-lifecycle.ts';

export interface CreateApiV1AdminOperationUseCasesInput {
    readonly database: PSqlSql;
    readonly databaseMode: ApiV1DatabaseConfiguration['mode'];
    readonly databasePubSubMode: ApiV1DatabaseConfiguration['pubSub'];
    readonly nowEpochMs: () => number;
    readonly serviceId: string;
    readonly timing: RallarTimingSink;
    readonly readWebSocketStatus: () => RallarServerWsStatus;
    readonly readRtcTopologyMetrics: () => object;
    readonly resetRtcTopologyMetrics: () => void;
    readonly readGroupFormationMetrics: RallarGroupFormationMetricsRecorder['readMetrics'];
    readonly resetGroupFormationMetrics: RallarGroupFormationMetricsRecorder['resetMetrics'];
    readonly crdtAdminRepository: RallarCrdtAdminReadRepository;
    readonly appAdminInboxService: PruneApiAdminExpiredData.Options['appAdminInbox'];
    readonly crdtAdminMutations: CrdtAdminMutations;
    readonly topologyInboxService: RecomputeApiAdminTopology.Options['topologyInbox'];
}

export function createApiV1AdminOperationUseCases(
    input: CreateApiV1AdminOperationUseCasesInput
): AdminOperationUseCases {
    const readerOptions = {
        nowEpochMs: input.nowEpochMs,
        serverId: input.serviceId
    };
    const queues = new PSqlAdminQueueReader(input.database, readerOptions);
    const state = new PSqlAdminStateReader(input.database, readerOptions);
    const crdt = new PSqlAdminCrdtReader(input.database, readerOptions);
    const system = new PSqlAdminSystemReader(input.database, {
        ...readerOptions,
        sqlBackend: input.databaseMode,
        dbPubSub: input.databasePubSubMode
    });
    const realtime = new ReadAdminRealtime({
        nowEpochMs: input.nowEpochMs,
        serverId: input.serviceId,
        readWebSocketStatus: input.readWebSocketStatus,
        readRtcTopologyMetrics: input.readRtcTopologyMetrics,
        readGroupFormationMetrics: input.readGroupFormationMetrics
    });
    const operations: AdminOperationUseCases = {
        overview: new ReadAdminOverview({
            nowEpochMs: input.nowEpochMs,
            serverId: input.serviceId,
            readQueues: async (request) => await queues.execute(request),
            readState: async (request) => await state.execute(request),
            readCrdt: async (request) => await crdt.execute(request),
            readSystem: async (request) => await system.execute(request),
            readRealtime: async (request) => await realtime.execute(request)
        }),
        queues,
        realtime,
        state,
        crdt,
        system,
        metricsReset: new ResetAdminMetrics({
            nowEpochMs: input.nowEpochMs,
            serverId: input.serviceId,
            timing: input.timing,
            rtcTopology: {
                read: input.readRtcTopologyMetrics,
                reset: input.resetRtcTopologyMetrics
            },
            groupFormation: {
                read: input.readGroupFormationMetrics,
                reset: input.resetGroupFormationMetrics
            }
        }),
        crdtIntegrity: new VerifyAdminCrdtIntegrity({
            serviceId: input.serviceId,
            timing: input.timing,
            repository: input.crdtAdminRepository
        }),
        crdtDebugExport: new ExportAdminCrdtDebug({
            serviceId: input.serviceId,
            timing: input.timing,
            repository: input.crdtAdminRepository
        }),
        topologyRecompute: new RecomputeApiAdminTopology({
            topologyInbox: input.topologyInboxService,
            nowEpochMs: input.nowEpochMs
        }),
        prune: new PruneApiAdminExpiredData({
            appAdminInbox: input.appAdminInboxService
        }),
        crdtCompact: new CompactApiAdminCrdt(input.crdtAdminMutations),
        crdtLifecycle: new UpdateApiAdminCrdtLifecycle(input.crdtAdminMutations),
        crdtErase: new EraseApiAdminCrdt(input.crdtAdminMutations)
    };
    return operations;
}
