import { PSqlAdminOperationsStatsReader } from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import { PSqlAdminSupportReader } from '@shared-server/postgres/admin-support/PSqlAdminSupportReader.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { RallarServerWsStatus } from '@shared-server/rallar-facade/ws-topic-router.ts';
import { AdminOperationsService } from '@shared-server/rallar-system/admin-operations/admin-operations-service.ts';
import {
    AdminSupportService,
    type AdminSupportTopologyManagement
} from '@shared-server/rallar-system/admin-support/AdminSupportService.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type { RallarGroupFormationMetricsRecorder } from '@shared-server/rallar-system/formation-metrics.ts';
import type { CachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import { SpaStatisticsService } from '@shared-server/rallar-system/spa-statistics/SpaStatisticsService.ts';
import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import {
    createApiAdminMutationGateway,
    type ApiAdminPruneMutationPort,
    type ApiTopologyRecomputeMutationPort
} from '../admin-operations/create-api-admin-mutation-gateway.ts';
import type { CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';
import type { ApiV1DatabaseBackendConfig } from '../db/database-config.ts';
import type { ApiV1DatabasePubSubConfig } from '../db/database-pubsub-config.ts';

export interface CreateApiV1AdminServicesInput {
    readonly database: PSqlSql;
    readonly databaseConfig: ApiV1DatabaseBackendConfig;
    readonly databasePubSub: ApiV1DatabasePubSubConfig;
    readonly nowEpochMs: () => number;
    readonly serviceId: string;
    readonly timing: RallarTimingSink;
    readonly readWebSocketStatus: () => RallarServerWsStatus;
    readonly readRtcTopologyMetrics: () => object;
    readonly resetRtcTopologyMetrics: () => void;
    readonly readGroupFormationMetrics: RallarGroupFormationMetricsRecorder['readMetrics'];
    readonly resetGroupFormationMetrics: RallarGroupFormationMetricsRecorder['resetMetrics'];
    readonly crdtAdminRepository: RallarCrdtAdminReadRepository;
    readonly topologyManagement: AdminSupportTopologyManagement;
    readonly clientStateService: Pick<ClientStateService, 'readSnapshot' | 'readPresenceSnapshot' | 'listRecentEvents'>;
    readonly groupStateService: Pick<
        CachedGroupStateService,
        | 'readSnapshot'
        | 'readCurrentSnapshot'
        | 'listRecentEvents'
        | 'listSnapshots'
        | 'listSnapshotsPage'
        | 'listEvents'
    >;
    readonly appAdminInboxService: ApiAdminPruneMutationPort;
    readonly crdtAdminMutations: CrdtAdminMutations;
    readonly appGroupInboxService: ApiTopologyRecomputeMutationPort;
}

export interface ApiV1AdminServices {
    readonly operations: AdminOperationsService;
    readonly support: AdminSupportService;
    readonly statistics: SpaStatisticsService;
}

export function createApiV1AdminServices(
    input: CreateApiV1AdminServicesInput
): ApiV1AdminServices {
    const readWebSocketStatus = input.readWebSocketStatus;
    return {
        operations: new AdminOperationsService({
            now: input.nowEpochMs,
            serverId: input.serviceId,
            statsReader: new PSqlAdminOperationsStatsReader(input.database, {
                now: input.nowEpochMs,
                serverId: input.serviceId,
                sqlBackend: input.databaseConfig.sqlBackend,
                dbPubSub: input.databasePubSub.mode
            }),
            wsStatus: readWebSocketStatus,
            readRtcTopologyMetrics: input.readRtcTopologyMetrics,
            resetRtcTopologyMetrics: input.resetRtcTopologyMetrics,
            readGroupFormationMetrics: input.readGroupFormationMetrics,
            resetGroupFormationMetrics: input.resetGroupFormationMetrics,
            crdtAdminRepository: input.crdtAdminRepository,
            mutationGateway: createApiAdminMutationGateway({
                appAdmin: input.appAdminInboxService,
                crdtAdminMutations: input.crdtAdminMutations,
                appGroup: input.appGroupInboxService,
                now: input.nowEpochMs
            }),
            timing: input.timing
        }),
        support: new AdminSupportService({
            now: input.nowEpochMs,
            serverId: input.serviceId,
            reader: new PSqlAdminSupportReader(input.database),
            clientStateService: input.clientStateService,
            groupStateService: input.groupStateService,
            topologyManagement: input.topologyManagement,
            wsStatus: readWebSocketStatus,
            crdtAdminRepository: input.crdtAdminRepository,
            timing: input.timing
        }),
        statistics: new SpaStatisticsService({
            now: input.nowEpochMs,
            clientStateService: input.clientStateService,
            groupStateService: input.groupStateService,
            wsStatus: readWebSocketStatus
        })
    };
}

export function readApiV1WebSocketStatus(
    socket: JsonWebSocketServer
): RallarServerWsStatus {
    const connections = [...socket.connections.values()].map((connection) => ({
        connectionId: connection.id,
        isOpen: connection.isOpen
    }));
    const openConnectionIds = connections
        .filter((connection) => connection.isOpen)
        .map((connection) => connection.connectionId);
    return {
        transport: 'ws-server',
        connectionCount: connections.length,
        openConnectionCount: openConnectionIds.length,
        connectionIds: connections.map((connection) => connection.connectionId),
        openConnectionIds,
        connections
    };
}
