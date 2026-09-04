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
import { requireSha256, requireString } from '../../validation/client-string-validation.ts';
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
        validateClientPersistence(value.persistence);
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
            'outboxEntries',
            'persistence'
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
    if (!Array.isArray(value.outboxEntries) || value.outboxEntries.length !== 2) {
        rejectClientMutation('Client mutation computed outboxEntries must contain snapshot and event');
    }
    validateClientPersistence(value.persistence);
}

function validateClientPersistence(value: ClientValidationValue): void {
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
        rejectClientMutation('Client mutation computed.persistence.runtimeWrites must be an array');
    }
    persistence.runtimeWrites.forEach(validateClientRuntimeWrite);
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

function validateClientRuntimeWrite(value: ClientValidationValue, index: number): void {
    const label = `Client mutation computed.persistence.runtimeWrites[${index}]`;
    const write = decodeClientValidationRecord(value, label);
    const commonKeys = ['kind', 'namespace', 'key', 'value', 'expireAtIsoTimestamp'];
    requireExactKeys(write, [...commonKeys, 'expectedRevision'], label);
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
        rejectClientMutation(`${label} guard is invalid`);
    }
}

function validateConditionalCandidate<T>(
    value: ClientValidationValue,
    label: string,
    validateValue: (value: ClientValidationValue, label: string) => void
): asserts value is ClientValidationRecord & ConditionalCandidate<T> {
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
            if (
                !Number.isSafeInteger(candidate.expectedRevision) ||
                (candidate.expectedRevision as number) < 0 ||
                Object.is(candidate.expectedRevision, -0)
            ) {
                rejectClientMutation(`${label}.expectedRevision must be a finite safe nonnegative integer`);
            }
            return;
        default:
            rejectClientMutation(`${label}.operation is invalid`);
    }
}
