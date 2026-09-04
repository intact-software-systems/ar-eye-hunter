import { validateComputedProjection } from '../../../computed-data-validation.ts';
import { assertPersistableClientStateEvent } from '../../../state-events/postgres/client-state-event-row-codec.ts';
import { validateClientEvent } from '../../client-state-contract-validation.ts';
import { assertCanonicalClientStateIdempotencyRecord } from '../../persistence/client-state-repository-reads.ts';
import {
    validatePersistedClientInstance,
    validatePersistedClientPrincipal,
    validatePersistedClientSession
} from '../../persistence/validate-persisted-client-state.ts';
import { ClientMutationRejectedError } from '../../validation/client-mutation-rejection.ts';
import {
    decodeClientValidationRecord,
    requireExactKeys,
    type ClientValidationValue
} from '../../validation/client-record-validation.ts';
import { requireString } from '../../validation/client-string-validation.ts';
import type {
    ClientMutationComputed,
    ClientMutationDomainWrite
} from '../client-mutation-contracts.ts';
import { computeClientPersistence } from '../compute/compute-client-persistence.ts';

export function validateClientPersistenceShape(value: ClientValidationValue): void {
    const persistence = decodeClientValidationRecord(
        value,
        'Client mutation computed.persistence'
    );
    requireExactKeys(
        persistence,
        ['runtimeWrites', 'eventWrite'],
        'Client mutation computed.persistence'
    );
    if (!Array.isArray(persistence.runtimeWrites)) {
        throw new ClientMutationRejectedError(
            'Client mutation computed.persistence.runtimeWrites must be an array'
        );
    }
    persistence.runtimeWrites.forEach(validateClientRuntimeWriteShape);
    if (persistence.eventWrite === null) {
        return;
    }
    const eventWrite = decodeClientValidationRecord(
        persistence.eventWrite,
        'Client mutation computed.persistence.eventWrite'
    );
    requireExactKeys(
        eventWrite,
        ['event', 'workspaceKey', 'eventJson'],
        'Client mutation computed.persistence.eventWrite'
    );
    validateClientEvent(eventWrite.event, 'Client mutation computed.persistence.eventWrite.event');
    requireString(
        eventWrite.workspaceKey,
        'Client mutation computed.persistence.eventWrite.workspaceKey'
    );
    requireString(eventWrite.eventJson, 'Client mutation computed.persistence.eventWrite.eventJson');
}

export function validateExactClientPersistence(
    computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>
): void {
    if (
        computed.outcome !== 'write' &&
        !(computed.outcome === 'no-op' && computed.persistIdempotency)
    ) {
        return;
    }
    validateClientPersistenceInput(computed);
    const issue = validateComputedProjection(
        computeClientPersistence(computed),
        computed.persistence,
        'Client mutation computed.persistence'
    )[0];
    if (issue !== undefined) {
        throw new ClientMutationRejectedError('Client computed persistence differs');
    }
}

function validateClientRuntimeWriteShape(value: ClientValidationValue, index: number): void {
    const label = `Client mutation computed.persistence.runtimeWrites[${index}]`;
    const write = decodeClientValidationRecord(value, label);
    requireExactKeys(
        write,
        ['kind', 'namespace', 'key', 'value', 'expireAtIsoTimestamp', 'expectedRevision'],
        label
    );
    requireString(write.namespace, `${label}.namespace`);
    requireString(write.key, `${label}.key`);
    requireString(write.value, `${label}.value`);
    requireString(write.expireAtIsoTimestamp, `${label}.expireAtIsoTimestamp`);
    if (write.kind === 'insert' && write.expectedRevision === null) {
        return;
    }
    if (
        write.kind !== 'update' ||
        !Number.isSafeInteger(write.expectedRevision) ||
        (write.expectedRevision as number) < 0
    ) {
        throw new ClientMutationRejectedError(`${label} guard is invalid`);
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
