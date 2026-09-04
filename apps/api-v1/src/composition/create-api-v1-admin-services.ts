import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AdminOperationUseCases } from '@shared-server/rallar-system/admin-operations/admin-operation-use-cases.ts';
import type {
    AdminSupportTopologyQuery,
    AdminSupportUseCases
} from '@shared-server/rallar-system/admin-support/admin-support-contracts.ts';
import {
    createAdminSupportUseCases
} from '@shared-server/rallar-system/admin-support/create-admin-support-use-cases.ts';
import { PSqlAdminSupportReader } from '@shared-server/rallar-system/admin-support/postgres/p-sql-admin-support-reader.ts';
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

import type { GroupAdminSupportDependencies } from '@shared-server/rallar-system/admin-support/admin-support-contracts.ts';
import {
    createApiV1AdminOperationUseCases,
    type CreateApiV1AdminOperationUseCasesInput
} from '../admin-operations/create-api-v1-admin-operation-use-cases.ts';
import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';

export interface CreateApiV1AdminServicesInput extends CreateApiV1AdminOperationUseCasesInput {
    readonly topologyQuery: AdminSupportTopologyQuery;
    readonly readLifecyclePolicy: GroupAdminSupportDependencies['readLifecyclePolicy'];
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
}

export interface ApiV1AdminServices {
    readonly operations: AdminOperationUseCases;
    readonly support: AdminSupportUseCases;
    readonly statistics: SpaStatisticsUseCases;
}

export function createApiV1AdminServices(
    input: CreateApiV1AdminServicesInput
): ApiV1AdminServices {
    const readWebSocketStatus = input.readWebSocketStatus;
    return {
        operations: createApiV1AdminOperationUseCases(input),
        support: createAdminSupportUseCases({
            now: input.nowEpochMs,
            serverId: input.serviceId,
            reader: new PSqlAdminSupportReader(input.database),
            clientStateService: input.clientStateService,
            groupStateService: input.groupStateService,
            topologyQuery: input.topologyQuery,
            readLifecyclePolicy: input.readLifecyclePolicy,
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
