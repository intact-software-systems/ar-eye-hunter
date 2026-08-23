import type { AdminPruneExpiredRequest, AdminTopologyRecomputeRequest } from '@shared/api/admin-operations-types.ts';
import type { RallarCrdtDocumentMetadata } from '@shared/crdt/mod.ts';
import type { CrdtAdminCompactResult, CrdtAdminEraseResult } from '../crdt/mutation/crdt-mutation-contracts.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';

import type { TopologyReconfigureInboxResult } from '../topology/inbox/topology-app-inbox-handler.ts';
import type { AdminOperationsMutationWriteInput } from './admin-operations-service.ts';
import type { AdminPruneEnqueueResult } from './inbox/app-admin-inbox-service.ts';

export type AdminOperationsMutationGateway = Readonly<{
    recomputeTopology(
        input: AdminOperationsMutationWriteInput<AdminTopologyRecomputeRequest>
    ): Promise<TopologyReconfigureInboxResult>;
    pruneExpired(
        input: AdminOperationsMutationWriteInput<AdminPruneExpiredRequest>
    ): Promise<AdminPruneEnqueueResult>;
    compactCrdt(input: AdminOperationsMutationWriteInput<JsonWireValue>): Promise<CrdtAdminCompactResult>;
    updateCrdtLifecycle(
        input: AdminOperationsMutationWriteInput<JsonWireValue>
    ): Promise<RallarCrdtDocumentMetadata>;
    eraseCrdt(input: AdminOperationsMutationWriteInput<JsonWireValue>): Promise<CrdtAdminEraseResult>;
}>;
