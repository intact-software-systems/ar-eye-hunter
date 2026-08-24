import { PSqlAdminOperationsStatsReader } from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import { PSqlAdminSupportReader } from '@shared-server/postgres/admin-support/PSqlAdminSupportReader.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AdminOperationsService } from '@shared-server/rallar-system/admin-operations/admin-operations-service.ts';
import type {
    AdminSupportTopologyQuery,
    AdminSupportUseCases
} from '@shared-server/rallar-system/admin-support/admin-support-contracts.ts';
import {
    createAdminSupportUseCases
} from '@shared-server/rallar-system/admin-support/create-admin-support-use-cases.ts';
import {
    createSpaStatisticsUseCases
} from '@shared-server/rallar-system/admin-support/statistics/create-spa-statistics-use-cases.ts';
import type {
    SpaStatisticsUseCases
} from '@shared-server/rallar-system/admin-support/statistics/spa-statistics-contracts.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type { CachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import type { RallarGroupFormationMetricsRecorder } from '@shared-server/rallar-system/observability/formation-metrics.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { RallarServerWsStatus } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-status.ts';
import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import {
    createApiAdminMutationGateway,
    type ApiAdminPruneMutationPort,
    type ApiTopologyRecomputeMutationPort
} from '../admin-operations/create-api-admin-mutation-gateway.ts';
import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';

export interface CreateApiV1AdminServicesInput {
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
    readonly topologyQuery: AdminSupportTopologyQuery;
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
    readonly topologyInboxService: ApiTopologyRecomputeMutationPort;
}

export interface ApiV1AdminServices {
    readonly operations: AdminOperationsService;
    readonly support: AdminSupportUseCases;
    readonly statistics: SpaStatisticsUseCases;
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
                sqlBackend: input.databaseMode,
                dbPubSub: input.databasePubSubMode
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
                topologyInbox: input.topologyInboxService,
                now: input.nowEpochMs
            }),
            timing: input.timing
        }),
        support: createAdminSupportUseCases({
            now: input.nowEpochMs,
            serverId: input.serviceId,
            reader: new PSqlAdminSupportReader(input.database),
            clientStateService: input.clientStateService,
            groupStateService: input.groupStateService,
            topologyQuery: input.topologyQuery,
            wsStatus: readWebSocketStatus,
            crdtAdminRepository: input.crdtAdminRepository,
            timing: input.timing
        }),
        statistics: createSpaStatisticsUseCases({
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
