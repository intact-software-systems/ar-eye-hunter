import { isValidRuntimeStateUpsertExpectedRevision } from '@shared-server/runtime-state/runtime-state-repository.ts';
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
    type ClientValidationRecord
} from '../../validation/client-record-validation.ts';
import { requireSha256 } from '../../validation/client-string-validation.ts';
import { validateClientPrincipalRef } from '../../validation/validate-client-principal-ref.ts';
import type { ClientMutationComputed, ConditionalCandidate } from '../client-mutation-contracts.ts';

export function validateClientMutationResult(
    computed: unknown
): asserts computed is ClientMutationComputed {
    const value = decodeClientValidationRecord(computed, 'Client mutation computed');
    switch (value.outcome) {
        case 'replay':
            validateReplayResult(value);
            return;
        case 'no-op':
            validateNoOpResult(value);
            return;
        case 'idempotency-conflict':
            validateIdempotencyConflictResult(value);
            return;
        case 'write':
            validateAppliedWriteResult(value);
            return;
        default:
            rejectClientMutation('Client mutation computed outcome is invalid');
    }
}

function validateReplayResult(value: ClientValidationRecord): void {
    requireExactKeys(value, ['outcome', 'receipt', 'snapshot', 'event'], 'Client mutation computed');
    validateClientMutationReceipt(value.receipt, 'Client mutation computed.receipt');
    validateAuthoritativeClientSnapshot(value.snapshot);
    if (value.event !== null) {
        validateClientEvent(value.event, 'Client mutation computed.event');
    }
}

function validateNoOpResult(value: ClientValidationRecord): void {
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
                'event'
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
    }
}

function validateIdempotencyConflictResult(value: ClientValidationRecord): void {
    requireExactKeys(
        value,
        ['outcome', 'existingCommandHash', 'receivedCommandHash'],
        'Client mutation computed'
    );
    requireSha256(value.existingCommandHash, 'Client mutation computed.existingCommandHash');
    requireSha256(value.receivedCommandHash, 'Client mutation computed.receivedCommandHash');
}

function validateAppliedWriteResult(value: ClientValidationRecord): void {
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
            'outboxWrites'
        ],
        'Client mutation computed'
    );
    const principalCandidate = value.principal;
    validateConditionalCandidate(
        principalCandidate,
        'Client mutation computed.principal',
        validateClientPrincipal
    );
    if (principalCandidate.operation === 'none') {
        rejectClientMutation('Client mutation computed principal guard is required');
    }
    validateConditionalCandidate(
        value.instance,
        'Client mutation computed.instance',
        validateClientInstance
    );
    validateConditionalCandidate(
        value.session,
        'Client mutation computed.session',
        validateClientSession
    );
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
    if (!Array.isArray(value.outboxWrites) || value.outboxWrites.length !== 2) {
        rejectClientMutation('Client mutation computed outboxWrites must contain snapshot and event');
    }
}

function validateConditionalCandidate<T>(
    value: unknown,
    label: string,
    validateValue: (value: unknown, label: string) => void
): asserts value is ConditionalCandidate<T> {
    const candidate = decodeClientValidationRecord(value, label);
    switch (candidate.operation) {
        case 'none':
            requireExactKeys(candidate, ['operation'], label);
            return;
        case 'insert':
            requireExactKeys(candidate, ['operation', 'value'], label);
            validateValue(candidate.value, `${label}.value`);
            return;
        case 'update':
            requireExactKeys(candidate, ['operation', 'value', 'expectedRevision'], label);
            validateValue(candidate.value, `${label}.value`);
            if (!isValidRuntimeStateUpsertExpectedRevision(candidate.expectedRevision)) {
                rejectClientMutation(`${label}.expectedRevision must be an incrementable runtime-state revision`);
            }
            return;
        default:
            rejectClientMutation(`${label}.operation is invalid`);
    }
}
