import type {
    AdminSupportExplainClientRequest,
    AdminSupportExplainCrdtDocumentRequest,
    AdminSupportExplainGroupRequest,
    AdminSupportExplainQueueItemRequest,
    AdminSupportExplainRequestRequest,
    AdminSupportNarrativeResponse
} from '@shared/api/admin-support/admin-support-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import type { ClientStateService } from '../client-state/client-state-service-contracts.ts';
import type { GroupStateService } from '../group-state/group-state-service-contracts.ts';
import type { RallarTimingSink } from '../observability/timing.ts';
import type { RallarServerWsStatus } from '../websocket/router/rallar-server-ws-status.ts';

export interface AdminSupportWriteInput<TRequest> {
    readonly adminSession: AuthSession;
    readonly request: TRequest;
}

export type AdminSupportQueueEntrySource = 'resource_inbox' | 'resource_inbox_results';

export interface AdminSupportQueueEntryRead {
    readonly source: AdminSupportQueueEntrySource;
    readonly key: Key;
    readonly typeId: string;
    readonly status: string;
    readonly attempts: number;
    readonly createdAtEpochMs?: number;
    readonly startedAtEpochMs?: number;
    readonly endedAtEpochMs?: number;
    readonly nextRetryAtEpochMs?: number;
    readonly expiresAtEpochMs?: number;
    readonly payload: string;
}

export interface AdminSupportReader {
    readonly readQueueEntry: (
        key: Key,
        includeExpired: boolean
    ) => Promise<AdminSupportQueueEntryRead | undefined>;
    readonly readQueueResult: (
        key: Key,
        includeExpired: boolean
    ) => Promise<AdminSupportQueueEntryRead | undefined>;
}

export type AdminSupportClientStateService = Pick<
    ClientStateService,
    'readSnapshot' | 'readPresenceSnapshot' | 'listRecentEvents'
>;

export type AdminSupportGroupStateService = Pick<GroupStateService, 'readSnapshot' | 'listRecentEvents'>;

export interface AdminSupportTopologyQuery {
    readonly readTopologyView: (groupRef: GroupRef) => Promise<GroupTopologyManagementView>;
}

export interface AdminSupportExecutionDependencies {
    readonly now: () => number;
    readonly serverId?: string;
    readonly timing?: RallarTimingSink;
}

export interface ClientAdminSupportDependencies extends AdminSupportExecutionDependencies {
    readonly clientStateService?: AdminSupportClientStateService;
    readonly wsStatus?: () => RallarServerWsStatus;
}

export interface GroupAdminSupportDependencies extends AdminSupportExecutionDependencies {
    readonly groupStateService?: AdminSupportGroupStateService;
    readonly topologyQuery?: AdminSupportTopologyQuery;
}

export interface CrdtAdminSupportDependencies extends AdminSupportExecutionDependencies {
    readonly crdtAdminRepository?: Partial<RallarCrdtAdminReadRepository>;
}

export interface QueueAdminSupportDependencies extends AdminSupportExecutionDependencies {
    readonly reader: AdminSupportReader;
}

export interface AdminSupportUseCaseDependencies
    extends
        ClientAdminSupportDependencies,
        GroupAdminSupportDependencies,
        CrdtAdminSupportDependencies,
        QueueAdminSupportDependencies {}

export interface AdminSupportUseCases {
    readonly explainClient: (
        input: AdminSupportWriteInput<AdminSupportExplainClientRequest>
    ) => Promise<AdminSupportNarrativeResponse>;
    readonly explainGroup: (
        input: AdminSupportWriteInput<AdminSupportExplainGroupRequest>
    ) => Promise<AdminSupportNarrativeResponse>;
    readonly explainRequest: (
        input: AdminSupportWriteInput<AdminSupportExplainRequestRequest>
    ) => Promise<AdminSupportNarrativeResponse>;
    readonly explainCrdtDocument: (
        input: AdminSupportWriteInput<AdminSupportExplainCrdtDocumentRequest>
    ) => Promise<AdminSupportNarrativeResponse>;
    readonly explainQueueItem: (
        input: AdminSupportWriteInput<AdminSupportExplainQueueItemRequest>
    ) => Promise<AdminSupportNarrativeResponse>;
}
