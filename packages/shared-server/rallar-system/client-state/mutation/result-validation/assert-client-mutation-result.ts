import { validateAuthoritativeClientSnapshot } from '@shared/api/authoritative-state-validation.ts';

import {
    validateClientMutationIdempotencyRecordValue,
    validateClientMutationReceipt
} from '../../client-mutation-receipt-validation.ts';
import {
    validateClientEvent,
    validateClientInstance,
    validateClientPrincipal,
    validateClientSession
} from '../../client-state-contract-validation.ts';
import { assertClientBoolean } from '../../validation/assert-client-boolean.ts';
import { rejectClientMutation } from '../../validation/client-mutation-rejection.ts';
import {
    decodeClientValidationRecord,
    requireExactKeys,
    type ClientValidationRecord,
    type ClientValidationValue
} from '../../validation/client-record-validation.ts';
import { requireSha256 } from '../../validation/client-string-validation.ts';
import { requireTimestamp } from '../../validation/client-timestamp-validation.ts';
import { validateClientPrincipalRef } from '../../validation/validate-client-principal-ref.ts';
import type { ClientMutationComputed } from '../client-mutation-contracts.ts';
import { assertClientPersistenceShape } from './assert-client-persistence.ts';

export function assertClientMutationResult(
    computed: unknown
): asserts computed is ClientMutationComputed {
    const value = decodeClientValidationRecord(computed, 'Client mutation computed');
    switch (value.outcome) {
        case 'replay':
            assertReplayResult(value);
            return;
        case 'no-op':
            assertNoOpResult(value);
            return;
        case 'idempotency-conflict':
            assertIdempotencyConflictResult(value);
            return;
        case 'write':
            assertAppliedWriteResult(value);
            return;
        default:
            rejectClientMutation('Client mutation computed outcome is invalid');
    }
}

function assertReplayResult(value: ClientValidationRecord): void {
    requireExactKeys(value, ['outcome', 'receipt', 'snapshot', 'event'], 'Client mutation computed');
    validateClientMutationReceipt(value.receipt, 'Client mutation computed.receipt');
    validateAuthoritativeClientSnapshot(value.snapshot);
    if (value.event !== null) {
        validateClientEvent(value.event, 'Client mutation computed.event');
    }
}

function assertNoOpResult(value: ClientValidationRecord): void {
    assertClientBoolean(value.persistIdempotency, 'Client mutation computed.persistIdempotency');
    requireExactKeys(
        value,
        value.persistIdempotency
            ? [
                'outcome',
                'persistIdempotency',
                'aggregateRef',
                'idempotency',
                'receipt',
                'snapshot',
                'event',
                'persistence'
            ]
            : ['outcome', 'persistIdempotency', 'receipt', 'snapshot', 'event'],
        'Client mutation computed'
    );
    validateClientMutationReceipt(value.receipt, 'Client mutation computed.receipt');
    validateAuthoritativeClientSnapshot(value.snapshot);
    if (value.event !== null) {
        rejectClientMutation('Client mutation computed no-op event must be null');
    }
    if (value.persistIdempotency) {
        validateClientPrincipalRef(value.aggregateRef, 'Client mutation computed.aggregateRef');
        validateClientMutationIdempotencyRecordValue(
            value.idempotency,
            'Client mutation computed.idempotency'
        );
        assertClientPersistenceShape(value.persistence);
    }
}

function assertIdempotencyConflictResult(value: ClientValidationRecord): void {
    requireExactKeys(
        value,
        ['outcome', 'existingCommandHash', 'receivedCommandHash'],
        'Client mutation computed'
    );
    requireSha256(value.existingCommandHash, 'Client mutation computed.existingCommandHash');
    requireSha256(value.receivedCommandHash, 'Client mutation computed.receivedCommandHash');
}

function assertAppliedWriteResult(value: ClientValidationRecord): void {
    requireExactKeys(
        value,
        [
            'outcome',
            'principal',
            'instance',
            'session',
            'event',
            'receipt',
            'snapshot',
            'idempotency',
            'stateSync',
            'outboxWrites',
            'persistence'
        ],
        'Client mutation computed'
    );
    const principalCandidate = validateConditionalCandidate(value.principal, 'Client mutation computed.principal');
    if (principalCandidate.operation === 'none') {
        rejectClientMutation('Client mutation computed principal guard is required');
    }
    validateClientPrincipal(principalCandidate.value, 'Client mutation computed.principal.value');
    if (principalCandidate.operation === 'update') {
        requireTimestamp(principalCandidate.expectedRevision, 'Client mutation computed.principal.expectedRevision');
    }
    const instanceCandidate = validateConditionalCandidate(value.instance, 'Client mutation computed.instance');
    if (instanceCandidate.operation !== 'none') {
        validateClientInstance(instanceCandidate.value, 'Client mutation computed.instance.value');
    }
    if (instanceCandidate.operation === 'update') {
        requireTimestamp(instanceCandidate.expectedRevision, 'Client mutation computed.instance.expectedRevision');
    }
    const sessionCandidate = validateConditionalCandidate(value.session, 'Client mutation computed.session');
    if (sessionCandidate.operation !== 'none') {
        validateClientSession(sessionCandidate.value, 'Client mutation computed.session.value');
    }
    if (sessionCandidate.operation === 'update') {
        requireTimestamp(sessionCandidate.expectedRevision, 'Client mutation computed.session.expectedRevision');
    }
    validateClientEvent(value.event, 'Client mutation computed.event');
    validateAuthoritativeClientSnapshot(value.snapshot);
    validateClientMutationReceipt(value.receipt, 'Client mutation computed.receipt');
    if (value.idempotency !== null) {
        validateClientMutationIdempotencyRecordValue(
            value.idempotency,
            'Client mutation computed.idempotency'
        );
    }
    if (!Array.isArray(value.stateSync) || value.stateSync.length !== 2) {
        rejectClientMutation('Client mutation computed stateSync must contain snapshot and event');
    }
    if (!Array.isArray(value.outboxWrites) || value.outboxWrites.length < 2) {
        rejectClientMutation('Client mutation computed outboxWrites must contain snapshot and event');
    }
    assertClientPersistenceShape(value.persistence);
}

function validateConditionalCandidate(
    value: ClientValidationValue,
    label: string
): ClientValidationRecord {
    const candidate = decodeClientValidationRecord(value, label);
    switch (candidate.operation) {
        case 'none':
            requireExactKeys(candidate, ['operation'], label);
            return candidate;
        case 'insert':
            requireExactKeys(candidate, ['operation', 'value'], label);
            return candidate;
        case 'update':
            requireExactKeys(candidate, ['operation', 'value', 'expectedRevision'], label);
            return candidate;
        default:
            rejectClientMutation(`${label}.operation is invalid`);
    }
}
