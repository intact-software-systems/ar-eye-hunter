import type {
    AdminPruneExpiredRequest,
    AdminTopologyRecomputeRequest,
} from '@shared/api/admin-operations-types.ts';
import type { RallarCrdtLifecycleInput } from '@shared/crdt/mod.ts';
import type {
    AdminOperationsWriteInput,
} from './AdminOperationsService.ts';

export type AdminOperationsMutationGateway = Readonly<{
    recomputeTopology(input: AdminOperationsWriteInput<AdminTopologyRecomputeRequest>): Promise<unknown>;
    pruneExpired(input: AdminOperationsWriteInput<AdminPruneExpiredRequest>): Promise<unknown>;
    compactCrdt(input: AdminOperationsWriteInput<unknown>): Promise<unknown>;
    updateCrdtLifecycle(input: AdminOperationsWriteInput<RallarCrdtLifecycleInput>): Promise<unknown>;
    eraseCrdt(input: AdminOperationsWriteInput<unknown>): Promise<unknown>;
}>;
