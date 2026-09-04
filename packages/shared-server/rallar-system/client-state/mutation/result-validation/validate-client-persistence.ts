import { assertPersistableClientStateEvent } from '../../../state-events/postgres/client-state-event-row-codec.ts';
import { assertCanonicalClientStateIdempotencyRecord } from '../../persistence/client-state-repository-reads.ts';
import {
    validatePersistedClientInstance,
    validatePersistedClientPrincipal,
    validatePersistedClientSession
} from '../../persistence/validate-persisted-client-state.ts';
import { ClientMutationRejectedError } from '../../validation/client-mutation-rejection.ts';
import type {
    ClientMutationComputed,
    ClientMutationDomainWrite
} from '../client-mutation-contracts.ts';
import { computeClientPersistence } from '../compute/compute-client-persistence.ts';

export function validateClientPersistence(
    computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>
): void {
    if (
        computed.outcome !== 'write' &&
        !(computed.outcome === 'no-op' && computed.persistIdempotency)
    ) {
        return;
    }
    validateClientPersistenceInput(computed);
    if (
        JSON.stringify(computeClientPersistence(computed)) !==
            JSON.stringify(computed.persistence)
    ) {
        throw new ClientMutationRejectedError('Client computed persistence differs');
    }
}

function validateClientPersistenceInput(computed: ClientMutationDomainWrite): void {
    if (computed.outcome === 'no-op') {
        assertCanonicalClientStateIdempotencyRecord(
            computed.idempotency,
            computed.aggregateRef,
            computed.idempotency.requestId
        );
        return;
    }
    validatePersistedClientPrincipal(computed.principal.value, computed.principal.value);
    if (computed.instance.operation !== 'none') {
        validatePersistedClientInstance(computed.instance.value, computed.instance.value);
    }
    if (computed.session.operation !== 'none') {
        validatePersistedClientSession(computed.session.value, computed.session.value);
    }
    if (computed.idempotency) {
        assertCanonicalClientStateIdempotencyRecord(
            computed.idempotency,
            computed.receipt.aggregateRef,
            computed.idempotency.requestId
        );
    }
    assertPersistableClientStateEvent(computed.event, computed.event);
}
