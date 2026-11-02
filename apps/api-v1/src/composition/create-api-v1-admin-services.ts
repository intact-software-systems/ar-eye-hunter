import { PSqlResourceInboxEntryReader } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-reader.ts';
import type { AdminOperationUseCases } from '@shared-server/rallar-system/admin-operations/admin-operation-use-cases.ts';
import { ReadAdminRoomDirectory } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-directory.ts';
import { ReadAdminRoomTopologyWork } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-work.ts';
import type {
    AdminSupportTopologyQuery,
    AdminSupportUseCases,
    GroupAdminSupportDependencies
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
import type { RallarServerWsStatus } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-status.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import {
    createApiV1AdminOperationUseCases,
    type CreateApiV1AdminOperationUseCasesInput
} from '../admin-operations/create-api-v1-admin-operation-use-cases.ts';

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
    readonly rooms: ReadAdminRoomDirectory;
    readonly topologyWork: ReadAdminRoomTopologyWork;
    readonly operations: AdminOperationUseCases;
    readonly support: AdminSupportUseCases;
    readonly statistics: SpaStatisticsUseCases;
}

export function createApiV1AdminServices(
    input: CreateApiV1AdminServicesInput
): ApiV1AdminServices {
    return {
        rooms: new ReadAdminRoomDirectory({
            repository: new PSqlRuntimeStateRepository(input.database),
            nowEpochMs: input.nowEpochMs
        }),
        topologyWork: new ReadAdminRoomTopologyWork({
            repository: new PSqlResourceInboxEntryReader(input.database, () => new Date(input.nowEpochMs())),
            nowEpochMs: input.nowEpochMs
        }),
        operations: createApiV1AdminOperationUseCases(input),
        support: createAdminSupportUseCases({
            now: input.nowEpochMs,
            serverId: input.serviceId,
            reader: new PSqlAdminSupportReader(input.database),
            clientStateService: input.clientStateService,
            groupStateService: input.groupStateService,
            topologyQuery: input.topologyQuery,
            readLifecyclePolicy: input.readLifecyclePolicy,
            wsStatus: input.readWebSocketStatus,
            crdtAdminRepository: input.crdtAdminRepository,
            timing: input.timing
        }),
        statistics: createSpaStatisticsUseCases({
            now: input.nowEpochMs,
            clientStateService: input.clientStateService,
            groupStateService: input.groupStateService,
            wsStatus: input.readWebSocketStatus
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
