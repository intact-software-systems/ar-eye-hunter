import type { GroupRef } from '@shared/api/group-types.ts';

import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    validateExactKeys,
    validateGroupRef,
    validateNonEmptyString,
    validateNonNegativeSafeInteger,
    validateNullableNonEmptyString,
    validateOneOf,
    validatePositiveSafeInteger,
    validateRecord,
    validateRequiredKeys,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';
import { validateCausalRevision, validateScopedRecord } from '../../persistence/validate-persisted-group.ts';

const MUTATION_RECEIPT_KEYS = [
    'commandId',
    'requestId',
    'commandHash',
    'aggregateRef',
    'outcome',
    'attemptCount',
    'acceptedStorageRevision',
    'snapshotVersion',
    'causalRevision',
    'eventId',
    'outboxIds',
    'joinCode',
    'joinCodeExpiresAtEpochMs',
    'rejection'
] as const;

export function validateGroupMutationIdempotencyRecord(
    record: unknown,
    ref: GroupRef
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const value = record;
    if (!isGroupStateRecord(value)) {
        return [...issues, ...validateRecord(value, 'Stored group idempotency value')];
    }
    issues.push(...validateExactKeys(
        value,
        ['aggregateRef', 'requestId', 'commandHash', 'receipt'],
        'Stored group idempotency value'
    ));
    issues.push(...validateRequiredKeys(
        value,
        ['aggregateRef', 'requestId', 'commandHash', 'receipt'],
        'Stored group idempotency value'
    ));
    issues.push(...validateGroupRef(value.aggregateRef));
    issues.push(...validateScopedRecord(value.aggregateRef, ref, 'Stored group idempotency aggregateRef'));
    issues.push(...validateNonEmptyString(value.requestId, 'Stored group idempotency requestId'));
    issues.push(...validateCommandHash(value.commandHash, 'Stored group idempotency commandHash'));
    issues.push(...validateMutationReceipt(value.receipt, ref, 'Stored group idempotency receipt'));
    const receipt = value.receipt;
    if (!isGroupStateRecord(receipt)) {
        return issues;
    }
    if (receipt.commandHash !== value.commandHash) {
        issues.push(toGroupStateValidationIssue('Stored group idempotency', 'Stored group idempotency hashes differ'));
    }
    if (receipt.commandId !== value.requestId) {
        issues.push(
            toGroupStateValidationIssue(
                'Stored group idempotency',
                'Stored group idempotency receipt command differs from request identity'
            )
        );
    }
    if (
        !isGroupStateRecord(receipt.aggregateRef) || receipt.aggregateRef.applicationId !== ref.applicationId ||
        receipt.aggregateRef.workspaceId !== ref.workspaceId ||
        receipt.aggregateRef.groupId !== ref.groupId
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'Stored group idempotency',
                'Stored group idempotency receipt differs from request identity'
            )
        );
    }
    return issues;
}

export function validateMutationReceipt(
    value: unknown,
    ref: GroupRef,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const receipt = value;
    if (!isGroupStateRecord(receipt)) {
        return [...issues, ...validateRecord(receipt, label)];
    }
    issues.push(...validateExactKeys(receipt, MUTATION_RECEIPT_KEYS, label));
    issues.push(...validateRequiredKeys(receipt, MUTATION_RECEIPT_KEYS, label));
    issues.push(...validateMutationReceiptIdentity(receipt, ref, label));
    issues.push(...validateMutationReceiptRevisions(receipt, label));
    issues.push(...validateMutationReceiptDetails(receipt, label));
    issues.push(...validateMutationReceiptOutcome(receipt, label));
    return issues;
}

function validateMutationReceiptIdentity(
    receipt: Record<string, unknown>,
    ref: GroupRef,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateNonEmptyString(receipt.commandId, `${label} commandId`));
    issues.push(...validateNullableNonEmptyString(receipt.requestId, `${label} requestId`));
    issues.push(...validateCommandHash(receipt.commandHash, `${label} commandHash`));
    const aggregateRef = receipt.aggregateRef;
    issues.push(...validateGroupRef(aggregateRef));
    issues.push(...validateScopedRecord(aggregateRef, ref, `${label} aggregateRef`));
    issues.push(...validateOneOf(receipt.outcome, ['applied', 'no-op', 'rejected'], `${label} outcome`));
    issues.push(...validatePositiveSafeInteger(receipt.attemptCount, `${label} attemptCount`));
    return issues;
}

function validateMutationReceiptRevisions(
    receipt: Record<string, unknown>,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (receipt.acceptedStorageRevision !== null) {
        issues.push(...validateNonNegativeSafeInteger(
            receipt.acceptedStorageRevision,
            `${label} acceptedStorageRevision`
        ));
    }
    issues.push(...validateNonNegativeSafeInteger(receipt.snapshotVersion, `${label} snapshotVersion`));
    const causalRevision = receipt.causalRevision;
    issues.push(...validateCausalRevision(causalRevision, label));
    if (isGroupStateRecord(causalRevision) && receipt.snapshotVersion !== causalRevision.groupRevision) {
        issues.push(toGroupStateValidationIssue(label, `${label} snapshotVersion differs from causalRevision`));
    }
    return issues;
}

function validateMutationReceiptDetails(
    receipt: Record<string, unknown>,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateNullableNonEmptyString(receipt.eventId, `${label} eventId`));
    if (!Array.isArray(receipt.outboxIds)) {
        issues.push(toGroupStateValidationIssue(label, `${label} outboxIds is invalid`));
    }
    for (const outboxId of Array.isArray(receipt.outboxIds) ? receipt.outboxIds : []) {
        issues.push(...validateNonEmptyString(outboxId, `${label} outboxId`));
    }
    if ((receipt.outcome === 'applied') !== (receipt.eventId !== null)) {
        issues.push(toGroupStateValidationIssue(label, `${label} event differs from outcome`));
    }
    if (receipt.joinCode !== null) {
        issues.push(...validateNonEmptyString(receipt.joinCode, `${label} joinCode`));
    }
    if (receipt.joinCodeExpiresAtEpochMs !== null) {
        issues.push(...validatePositiveSafeInteger(
            receipt.joinCodeExpiresAtEpochMs,
            `${label} joinCodeExpiresAtEpochMs`
        ));
    }
    if ((receipt.joinCode === null) !== (receipt.joinCodeExpiresAtEpochMs === null)) {
        issues.push(toGroupStateValidationIssue(label, `${label} join-code fields must have matching presence`));
    }
    if (receipt.rejection !== null) {
        issues.push(...validateNonEmptyString(receipt.rejection, `${label} rejection`));
    }
    if ((receipt.outcome === 'rejected') !== (receipt.rejection !== null)) {
        issues.push(toGroupStateValidationIssue(label, `${label} rejection differs from outcome`));
    }
    return issues;
}

export function validateCommandHash(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        issues.push(toGroupStateValidationIssue(label, `${label} is invalid`));
    }
    return issues;
}

function validateMutationReceiptOutcome(
    receipt: Record<string, unknown>,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!isGroupStateRecord(receipt.causalRevision) || !Array.isArray(receipt.outboxIds)) {
        return issues;
    }
    const causalRevision = receipt.causalRevision;
    const outboxIds = receipt.outboxIds;
    if (receipt.outcome === 'applied') {
        issues.push(...validateAppliedReceipt({ receipt, causalRevision, outboxIds, label }));
        return issues;
    }
    if (outboxIds.length !== 0) {
        issues.push(toGroupStateValidationIssue(label, `${label} outboxIds differs from non-applied outcome`));
    }
    if (receipt.joinCode !== null || receipt.joinCodeExpiresAtEpochMs !== null) {
        issues.push(toGroupStateValidationIssue(label, `${label} join-code fields require an applied outcome`));
    }
    if (receipt.outcome === 'no-op') {
        issues.push(...validateNoOpReceipt(receipt, label));
        return issues;
    }
    issues.push(...validateRejectedReceipt(receipt, causalRevision, label));
    return issues;
}

interface ValidateAppliedReceiptInput {
    readonly receipt: Record<string, unknown>;
    readonly causalRevision: Record<string, unknown>;
    readonly outboxIds: readonly unknown[];
    readonly label: string;
}

function validateAppliedReceipt({
    receipt,
    causalRevision,
    outboxIds,
    label
}: ValidateAppliedReceiptInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (receipt.acceptedStorageRevision === null) {
        issues.push(
            toGroupStateValidationIssue(
                'receipt',
                `${label} acceptedStorageRevision is required when applied`
            )
        );
    }
    issues.push(...validatePositiveSafeInteger(receipt.snapshotVersion, `${label} applied snapshotVersion`));
    issues.push(...validatePositiveSafeInteger(causalRevision.groupRevision, `${label} applied groupRevision`));
    // One presence-summary id, plus the formation timers a lifecycle transition
    // arms; the entries themselves are verified canonically at compute time.
    if (outboxIds.slice(1).some((outboxId) => typeof outboxId !== 'string' || !outboxId.startsWith('ft-'))) {
        issues.push(
            toGroupStateValidationIssue('receipt', `${label} outboxIds differs from applied outcome`)
        );
    }
    return issues;
}

// Physical storage revisions and semantic group revisions are independent:
// presence writes advance the group row as an authority fence without changing
// the group snapshot, while reincarnation can restore a newer semantic revision.
function validateNoOpReceipt(
    receipt: Record<string, unknown>,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validatePositiveSafeInteger(receipt.snapshotVersion, `${label} no-op snapshotVersion`));
    if (receipt.acceptedStorageRevision === null) {
        issues.push(toGroupStateValidationIssue(label, `${label} no-op acceptedStorageRevision is required`));
    }
    return issues;
}

function validateRejectedReceipt(
    receipt: Record<string, unknown>,
    causalRevision: Record<string, unknown>,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (receipt.acceptedStorageRevision === null) {
        if (
            causalRevision.groupRevision !== 0 ||
            causalRevision.presenceRevision !== 0 ||
            receipt.snapshotVersion !== 0
        ) {
            issues.push(toGroupStateValidationIssue(label, `${label} absent-group rejection has authority`));
        }
        return issues;
    }
    issues.push(...validatePositiveSafeInteger(receipt.snapshotVersion, `${label} rejected snapshotVersion`));
    return issues;
}

