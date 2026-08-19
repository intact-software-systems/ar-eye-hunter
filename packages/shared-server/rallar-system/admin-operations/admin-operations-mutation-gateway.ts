import type {
  AdminPruneExpiredRequest,
  AdminTopologyRecomputeRequest,
} from '@shared/api/admin-operations-types.ts';
import type { RallarCrdtDocumentMetadata, RallarCrdtLifecycleInput } from '@shared/crdt/mod.ts';
import type {
  CrdtAdminCompactResult,
  CrdtAdminEraseResult,
} from '../crdt/mutation/crdt-mutation-contracts.ts';
// prettier-ignore
import type {
  TopologyReconfigureInboxResult,
} from '../topology/inbox/topology-app-inbox-handler.ts';
import type { AdminOperationsWriteInput } from './AdminOperationsService.ts';
import type { AdminPruneEnqueueResult } from './inbox/app-admin-inbox-service.ts';

export type AdminOperationsMutationGateway = Readonly<{
  recomputeTopology(
    input: AdminOperationsWriteInput<AdminTopologyRecomputeRequest>,
  ): Promise<TopologyReconfigureInboxResult>;
  pruneExpired(
    input: AdminOperationsWriteInput<AdminPruneExpiredRequest>,
  ): Promise<AdminPruneEnqueueResult>;
  compactCrdt(input: AdminOperationsWriteInput<unknown>): Promise<CrdtAdminCompactResult>;
  updateCrdtLifecycle(
    input: AdminOperationsWriteInput<RallarCrdtLifecycleInput>,
  ): Promise<RallarCrdtDocumentMetadata>;
  eraseCrdt(input: AdminOperationsWriteInput<unknown>): Promise<CrdtAdminEraseResult>;
}>;
