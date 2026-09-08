import type {
    ClientMutationIdempotencyRecord,
    ClientMutationReceipt
} from './persistence/client-state-persistence-contracts.ts';
import { requireEnum } from './validation/client-enum-validation.ts';
import { rejectClientMutation } from './validation/client-mutation-rejection.ts';
import {
    decodeClientValidationRecord,
    requireExactKeys,
    type ClientValidationRecord
} from './validation/client-record-validation.ts';
import {
    requireNonEmptyString,
    requireNullableNonEmptyString,
    requireSha256,
    requireStringArray
} from './validation/client-string-validation.ts';
import { requirePositiveSafeInteger, requireTimestamp } from './validation/client-timestamp-validation.ts';
import { validateClientPrincipalRef } from './validation/validate-client-principal-ref.ts';

export function validateClientMutationReceipt(
    value: unknown,
    label: string
): asserts value is ClientMutationReceipt {
    const receipt = decodeClientValidationRecord(value, label);
    requireExactKeys(
        receipt,
        [
            'commandId',
            'requestId',
            'commandHash',
            'aggregateRef',
            'outcome',
            'attemptCount',
            'acceptedStorageRevision',
            'stateRevision',
            'snapshotVersion',
            'presenceVersion',
            'eventId',
            'outboxIds'
        ],
        label
    );
    requireNonEmptyString(receipt.commandId, `${label}.commandId`);
    requireNullableNonEmptyString(receipt.requestId, `${label}.requestId`);
    requireSha256(receipt.commandHash, `${label}.commandHash`);
    validateClientPrincipalRef(receipt.aggregateRef, `${label}.aggregateRef`);
    requireEnum(receipt.outcome, new Set(['applied', 'no-op']), `${label}.outcome`);
    requirePositiveSafeInteger(receipt.attemptCount, `${label}.attemptCount`);
    validateClientMutationReceiptRevisions(receipt, label);
    validateClientMutationReceiptOutcome(receipt, label);
}

function validateClientMutationReceiptRevisions(
    receipt: ClientValidationRecord,
    label: string
): void {
    if (receipt.acceptedStorageRevision === null) {
        rejectClientMutation(`${label}.acceptedStorageRevision is required`);
    }
    requireTimestamp(receipt.acceptedStorageRevision, `${label}.acceptedStorageRevision`);
    requirePositiveSafeInteger(receipt.stateRevision, `${label}.stateRevision`);
    requirePositiveSafeInteger(receipt.snapshotVersion, `${label}.snapshotVersion`);
    requirePositiveSafeInteger(receipt.presenceVersion, `${label}.presenceVersion`);
    if (receipt.stateRevision !== receipt.acceptedStorageRevision + 1) {
        rejectClientMutation(`${label}.stateRevision differs from acceptedStorageRevision`);
    }
}

function validateClientMutationReceiptOutcome(
    receipt: ClientValidationRecord,
    label: string
): void {
    requireNullableNonEmptyString(receipt.eventId, `${label}.eventId`);
    requireStringArray(receipt.outboxIds, `${label}.outboxIds`);
    if ((receipt.outcome === 'applied') !== (receipt.eventId !== null)) {
        rejectClientMutation(`${label}.eventId differs from outcome`);
    }
    // Applied writes publish an event and at least one snapshot carrier; paging can add more.
    const hasRequiredOutbox = receipt.outcome === 'applied'
        ? receipt.outboxIds.length >= 2
        : receipt.outboxIds.length === 0;
    if (!hasRequiredOutbox) {
        rejectClientMutation(`${label}.outboxIds differs from outcome`);
    }
    const outboxIds = receipt.outboxIds;
    if (
        receipt.outcome === 'applied' &&
        (new Set(outboxIds).size !== outboxIds.length || outboxIds.some((outboxId) => !outboxId))
    ) {
        rejectClientMutation(`${label}.outboxIds are not unique durable identities`);
    }
}

export function validateClientMutationIdempotencyRecordValue(
    value: unknown,
    label: string
): asserts value is ClientMutationIdempotencyRecord {
    const record = decodeClientValidationRecord(value, label);
    requireExactKeys(record, ['requestId', 'commandHash', 'receipt'], label);
    requireNonEmptyString(record.requestId, `${label}.requestId`);
    requireSha256(record.commandHash, `${label}.commandHash`);
    validateClientMutationReceipt(record.receipt, `${label}.receipt`);
    const receipt = record.receipt;
    if (
        receipt.commandHash !== record.commandHash ||
        receipt.requestId !== record.requestId ||
        receipt.commandId !== record.requestId
    ) {
        rejectClientMutation(`${label} receipt hash differs`);
    }
}
