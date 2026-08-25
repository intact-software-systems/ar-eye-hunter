import type {
    AdminMetricsResetRequest,
    AdminOperationResultResponse,
    AdminOperationsCrdtResponse,
    AdminOperationsOverviewResponse,
    AdminOperationsQueuesResponse,
    AdminOperationsRealtimeResponse,
    AdminOperationsStateResponse,
    AdminOperationsSystemResponse,
    AdminPruneExpiredRequest,
    AdminTopologyRecomputeRequest
} from '@shared/api/admin-operations-types.ts';
import type { RallarCrdtDebugBundle, RallarCrdtDocumentMetadata, RallarCrdtIntegrityReport } from '@shared/crdt/mod.ts';

import type { CrdtAdminCompactResult, CrdtAdminEraseResult } from '../crdt/mutation/crdt-mutation-contracts.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';
import type { TopologyReconfigureInboxResult } from '../topology/inbox/topology-app-inbox-handler.ts';
import type {
    AdminOperationMutationRequest,
    AdminOperationReadRequest,
    AdminOperationWriteRequest
} from './admin-operation-request.ts';
import type { ExportAdminCrdtDebug } from './export-admin-crdt-debug.ts';
import type { AdminPruneEnqueueResult } from './inbox/app-admin-inbox-service.ts';
import type { VerifyAdminCrdtIntegrity } from './verify-admin-crdt-integrity.ts';

export interface AdminOperationUseCase<TInput, TResponse> {
    execute(input: TInput): Promise<TResponse>;
}

export interface AdminOperationUseCases {
    readonly overview: AdminOperationUseCase<AdminOperationReadRequest, AdminOperationsOverviewResponse>;
    readonly queues: AdminOperationUseCase<AdminOperationReadRequest, AdminOperationsQueuesResponse>;
    readonly realtime: AdminOperationUseCase<AdminOperationReadRequest, AdminOperationsRealtimeResponse>;
    readonly state: AdminOperationUseCase<AdminOperationReadRequest, AdminOperationsStateResponse>;
    readonly crdt: AdminOperationUseCase<AdminOperationReadRequest, AdminOperationsCrdtResponse>;
    readonly system: AdminOperationUseCase<AdminOperationReadRequest, AdminOperationsSystemResponse>;
    readonly metricsReset: AdminOperationUseCase<
        AdminOperationWriteRequest<AdminMetricsResetRequest>,
        AdminOperationResultResponse
    >;
    readonly crdtIntegrity: AdminOperationUseCase<
        AdminOperationWriteRequest<VerifyAdminCrdtIntegrity.Request>,
        RallarCrdtIntegrityReport
    >;
    readonly crdtDebugExport: AdminOperationUseCase<
        AdminOperationWriteRequest<ExportAdminCrdtDebug.Request>,
        RallarCrdtDebugBundle
    >;
    readonly topologyRecompute: AdminOperationUseCase<
        AdminOperationMutationRequest<AdminTopologyRecomputeRequest>,
        TopologyReconfigureInboxResult
    >;
    readonly prune: AdminOperationUseCase<
        AdminOperationMutationRequest<AdminPruneExpiredRequest>,
        AdminPruneEnqueueResult
    >;
    readonly crdtCompact: AdminOperationUseCase<AdminOperationMutationRequest<JsonWireValue>, CrdtAdminCompactResult>;
    readonly crdtLifecycle: AdminOperationUseCase<
        AdminOperationMutationRequest<JsonWireValue>,
        RallarCrdtDocumentMetadata
    >;
    readonly crdtErase: AdminOperationUseCase<AdminOperationMutationRequest<JsonWireValue>, CrdtAdminEraseResult>;
}
