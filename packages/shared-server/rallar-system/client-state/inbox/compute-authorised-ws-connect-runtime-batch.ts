import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchGuard,
    RuntimeStateGuardedBatchWrite
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatch } from '../../../runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import type { AuthWsTicketConsumption } from '../../auth/ws-ticket/auth-ws-ticket-consumption.ts';
import type { WsSessionGenerationLifecycleComputed } from '../../websocket/ws-session-generation-computation.ts';
import type {
    ClientMutationComputedWrite,
    ClientRuntimePersistenceOperation
} from '../mutation/client-mutation-contracts.ts';
import {
    toClientSnapshotProvenanceEffect,
    type ClientSnapshotProvenanceInsert
} from '../persistence/client-snapshot-provenance.ts';
import { CLIENT_STATE_PRINCIPALS_NAMESPACE } from '../persistence/client-state-runtime-namespaces.ts';

export interface ComputeAuthorisedWsConnectRuntimeBatchInput {
    readonly ticketConsumption: AuthWsTicketConsumption;
    readonly lifecycleComputed: WsSessionGenerationLifecycleComputed;
    readonly writes: readonly ClientMutationComputedWrite[];
    readonly sidecarWrites: readonly ClientSnapshotProvenanceInsert[];
}

/**
 * Every runtime row an authorised connect writes, as one guarded batch: the principal's compare-and-set guards it
 * when the connect writes the principal, otherwise the ticket's guarded delete does; every other row is an effect.
 */
export function computeAuthorisedWsConnectRuntimeBatch(
    input: ComputeAuthorisedWsConnectRuntimeBatchInput
): RuntimeStateGuardedBatchWrite {
    const clientRows = input.writes.flatMap((write) => write.persistence.runtimeWrites);
    const principal = clientRows.find((row) => row.namespace === CLIENT_STATE_PRINCIPALS_NAMESPACE);
    const ticket: RuntimeStateGuardedBatchGuard = {
        operation: 'delete',
        namespace: input.ticketConsumption.namespace,
        key: input.ticketConsumption.key,
        expectedRevision: input.ticketConsumption.expectedRevision
    };
    const lifecycle = input.lifecycleComputed.row;
    const effects: RuntimeStateGuardedBatchEffect[] = [
        ...(principal === undefined ? [] : [{ ...ticket, effectId: 'ws-ticket' }]),
        ...(lifecycle === null ? [] : [{ ...lifecycle.descriptor, effectId: 'ws-session-lifecycle' }]),
        ...clientRows
            .filter((row) => row !== principal)
            .map((row) => ({ ...toClientRuntimeRow(row), effectId: `client:${row.namespace}` })),
        ...input.sidecarWrites.map(toClientSnapshotProvenanceEffect)
    ];
    return computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
        guard: principal === undefined ? ticket : toClientRuntimeRow(principal),
        effects
    }));
}

function toClientRuntimeRow(row: ClientRuntimePersistenceOperation): RuntimeStateGuardedBatchGuard {
    const stored = {
        namespace: row.namespace,
        key: row.key,
        value: row.value,
        expireAtTimestamp: Date.parse(row.expireAtIsoTimestamp)
    };
    return row.kind === 'insert'
        ? { ...stored, operation: 'insert' }
        : { ...stored, operation: 'update', expectedRevision: row.expectedRevision };
}
