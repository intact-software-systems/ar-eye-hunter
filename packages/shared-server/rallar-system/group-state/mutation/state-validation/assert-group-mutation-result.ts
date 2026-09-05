import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';

import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../../../protocol/json-wire-identity.ts';
import {
    assertExactKeys,
    assertRequiredKeys,
    nullableNonEmptyString,
    requireNonEmptyString,
    requireNonNegativeSafeInteger,
    requirePositiveSafeInteger,
    validateGroupRef
} from '../../group-state-validation-primitives.ts';
import { validateCausalRevision, validateScopedValue } from '../../persistence/validate-persisted-group.ts';
import type { GroupMutationIdempotencyRecord, GroupMutationReceipt } from '../group-mutation-contracts.ts';

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

export function assertGroupMutationIdempotencyRecord(
    record: unknown,
    ref: GroupRef
): asserts record is GroupMutationIdempotencyRecord {
    const value = decodeGroupMutationResultRecord(record, 'Stored group idempotency value');
    assertExactKeys(
        value,
        ['aggregateRef', 'requestId', 'commandHash', 'receipt'],
        'Stored group idempotency value'
    );
    assertRequiredKeys(
        value,
        ['aggregateRef', 'requestId', 'commandHash', 'receipt'],
        'Stored group idempotency value'
    );
    validateGroupRef(value.aggregateRef);
    validateScopedValue(value.aggregateRef, ref, 'Stored group idempotency aggregateRef');
    requireNonEmptyString(value.requestId, 'Stored group idempotency requestId');
    assertCommandHash(value.commandHash, 'Stored group idempotency commandHash');
    const receipt = value.receipt;
    assertMutationReceipt(receipt, ref, 'Stored group idempotency receipt');
    if (receipt.commandHash !== value.commandHash) {
        throw new TypeError('Stored group idempotency hashes differ');
    }
    if (receipt.commandId !== value.requestId) {
        throw new TypeError('Stored group idempotency receipt command differs from request identity');
    }
    if (
        receipt.aggregateRef.applicationId !== ref.applicationId ||
        receipt.aggregateRef.workspaceId !== ref.workspaceId ||
        receipt.aggregateRef.groupId !== ref.groupId
    ) {
        throw new TypeError('Stored group idempotency receipt differs from request identity');
    }
}

export function assertMutationReceipt(
    value: unknown,
    ref: GroupRef,
    label: string
): asserts value is GroupMutationReceipt {
    const receipt = decodeGroupMutationResultRecord(value, label);
    assertExactKeys(receipt, MUTATION_RECEIPT_KEYS, label);
    assertRequiredKeys(receipt, MUTATION_RECEIPT_KEYS, label);
    const outcome = assertMutationReceiptIdentity(receipt, ref, label);
    const causalRevision = assertMutationReceiptRevisions(receipt, label);
    const outboxIds = assertMutationReceiptDetails(receipt, outcome, label);
    assertMutationReceiptOutcome({ receipt, outcome, causalRevision, outboxIds, label });
}

function assertMutationReceiptIdentity(
    receipt: JsonWireObject,
    ref: GroupRef,
    label: string
): GroupMutationReceipt['outcome'] {
    requireNonEmptyString(receipt.commandId, `${label} commandId`);
    nullableNonEmptyString(receipt.requestId, `${label} requestId`);
    assertCommandHash(receipt.commandHash, `${label} commandHash`);
    const aggregateRef = receipt.aggregateRef;
    validateGroupRef(aggregateRef);
    validateScopedValue(aggregateRef, ref, `${label} aggregateRef`);
    const outcome = receipt.outcome;
    if (outcome !== 'applied' && outcome !== 'no-op' && outcome !== 'rejected') {
        throw new TypeError(`${label} outcome is invalid`);
    }
    requirePositiveSafeInteger(receipt.attemptCount, `${label} attemptCount`);
    return outcome;
}

function assertMutationReceiptRevisions(
    receipt: JsonWireObject,
    label: string
): GroupStateCausalRevision {
    if (receipt.acceptedStorageRevision !== null) {
        requireNonNegativeSafeInteger(
            receipt.acceptedStorageRevision,
            `${label} acceptedStorageRevision`
        );
    }
    requireNonNegativeSafeInteger(receipt.snapshotVersion, `${label} snapshotVersion`);
    const causalRevision = receipt.causalRevision;
    validateCausalRevision(causalRevision, label);
    if (receipt.snapshotVersion !== causalRevision.groupRevision) {
        throw new TypeError(`${label} snapshotVersion differs from causalRevision`);
    }
    return causalRevision;
}

function assertMutationReceiptDetails(
    receipt: JsonWireObject,
    outcome: GroupMutationReceipt['outcome'],
    label: string
): readonly string[] {
    nullableNonEmptyString(receipt.eventId, `${label} eventId`);
    if (!Array.isArray(receipt.outboxIds)) {
        throw new TypeError(`${label} outboxIds is invalid`);
    }
    const outboxIds = receipt.outboxIds.map((outboxId) => {
        requireNonEmptyString(outboxId, `${label} outboxId`);
        return outboxId;
    });
    if ((outcome === 'applied') !== (receipt.eventId !== null)) {
        throw new TypeError(`${label} event differs from outcome`);
    }
    if (receipt.joinCode !== null) {
        requireNonEmptyString(receipt.joinCode, `${label} joinCode`);
    }
    if (receipt.joinCodeExpiresAtEpochMs !== null) {
        requirePositiveSafeInteger(
            receipt.joinCodeExpiresAtEpochMs,
            `${label} joinCodeExpiresAtEpochMs`
        );
    }
    if ((receipt.joinCode === null) !== (receipt.joinCodeExpiresAtEpochMs === null)) {
        throw new TypeError(`${label} join-code fields must have matching presence`);
    }
    if (receipt.rejection !== null) {
        requireNonEmptyString(receipt.rejection, `${label} rejection`);
    }
    if ((outcome === 'rejected') !== (receipt.rejection !== null)) {
        throw new TypeError(`${label} rejection differs from outcome`);
    }
    return outboxIds;
}

export function assertCommandHash(value: JsonWireValue, label: string): asserts value is string {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
}

interface AssertMutationReceiptOutcomeInput {
    readonly receipt: JsonWireObject;
    readonly outcome: GroupMutationReceipt['outcome'];
    readonly causalRevision: GroupStateCausalRevision;
    readonly outboxIds: readonly string[];
    readonly label: string;
}

function assertMutationReceiptOutcome({
    receipt,
    outcome,
    causalRevision,
    outboxIds,
    label
}: AssertMutationReceiptOutcomeInput): void {
    if (outcome === 'applied') {
        assertAppliedReceipt({ receipt, causalRevision, outboxIds, label });
        return;
    }
    if (outboxIds.length !== 0) {
        throw new TypeError(`${label} outboxIds differs from non-applied outcome`);
    }
    if (receipt.joinCode !== null || receipt.joinCodeExpiresAtEpochMs !== null) {
        throw new TypeError(`${label} join-code fields require an applied outcome`);
    }
    if (outcome === 'no-op') {
        assertNoOpReceipt(receipt, label);
        return;
    }
    assertRejectedReceipt(receipt, causalRevision, label);
}

interface AssertAppliedReceiptInput {
    readonly receipt: JsonWireObject;
    readonly causalRevision: GroupStateCausalRevision;
    readonly outboxIds: readonly string[];
    readonly label: string;
}

function assertAppliedReceipt({
    receipt,
    causalRevision,
    outboxIds,
    label
}: AssertAppliedReceiptInput): void {
    if (receipt.acceptedStorageRevision === null) {
        throw new TypeError(`${label} acceptedStorageRevision is required when applied`);
    }
    requirePositiveSafeInteger(receipt.snapshotVersion, `${label} applied snapshotVersion`);
    requirePositiveSafeInteger(causalRevision.groupRevision, `${label} applied groupRevision`);
    // One presence-summary id, plus the formation timers a lifecycle transition
    // arms; the entries themselves are verified canonically at compute time.
    if (outboxIds.slice(1).some((outboxId) => !outboxId.startsWith('ft-') && !outboxId.startsWith('ct-'))) {
        throw new TypeError(`${label} outboxIds differs from applied outcome`);
    }
}

// Physical storage revisions and semantic group revisions are independent. Presence writes
// advance the group row as an authority fence without changing the group snapshot, while
// reincarnation can restore a newer semantic revision.
function assertNoOpReceipt(
    receipt: JsonWireObject,
    label: string
): void {
    requirePositiveSafeInteger(receipt.snapshotVersion, `${label} no-op snapshotVersion`);
    if (receipt.acceptedStorageRevision === null) {
        throw new TypeError(`${label} no-op acceptedStorageRevision is required`);
    }
}

function assertRejectedReceipt(
    receipt: JsonWireObject,
    causalRevision: GroupStateCausalRevision,
    label: string
): void {
    if (receipt.acceptedStorageRevision === null) {
        if (
            causalRevision.groupRevision !== 0 ||
            causalRevision.presenceRevision !== 0 ||
            receipt.snapshotVersion !== 0
        ) {
            throw new TypeError(`${label} absent-group rejection has authority`);
        }
        return;
    }
    requirePositiveSafeInteger(receipt.snapshotVersion, `${label} rejected snapshotVersion`);
}

function decodeGroupMutationResultRecord(value: unknown, label: string): JsonWireObject {
    const decoded = decodeJsonWireValue(value, label);
    if (!isJsonWireObject(decoded)) {
        throw new TypeError(`${label} must be an object`);
    }
    return decoded;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
