import type { ALSupersedencePersistenceValue } from '@shared/al-contracts/al-runtime.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot
} from '@shared/alm/ALRuntimeStateStores.ts';
import type { JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import {
    createALJsonPersistenceCodec,
    hasOnlyKeys,
    isFiniteNumber,
    isOptionalFiniteNumber,
    isRecord,
    isString,
    isStringArray
} from './al-json-persistence-codec.ts';

export const alSupersedencePersistenceCodec = createALJsonPersistenceCodec<ALSupersedencePersistenceValue>(
    'AL supersedence value',
    decodeALSupersedencePersistenceValue
);

export const alOutboundPendingAckCodec = createALJsonPersistenceCodec<ALOutboundPendingAckSnapshot>(
    'AL outbound pending-ack snapshot',
    decodeALOutboundPendingAckSnapshot
);

export const alOutboundRepairAttemptCodec = createALJsonPersistenceCodec<ALOutboundRepairAttemptSnapshot>(
    'AL outbound repair-attempt snapshot',
    decodeALOutboundRepairAttemptSnapshot
);

function decodeALSupersedencePersistenceValue(
    input: JsonWireValue
): ALSupersedencePersistenceValue {
    if (!isALSupersedencePersistenceValue(input)) {
        throw new TypeError(
            'Stored AL supersedence value does not match the current contract'
        );
    }
    return input;
}

function decodeALOutboundPendingAckSnapshot(
    input: JsonWireValue
): ALOutboundPendingAckSnapshot {
    if (!isALOutboundPendingAckSnapshot(input)) {
        throw new TypeError(
            'Stored AL outbound pending-ack snapshot does not match the current contract'
        );
    }
    return input;
}

function decodeALOutboundRepairAttemptSnapshot(
    input: JsonWireValue
): ALOutboundRepairAttemptSnapshot {
    if (!isALOutboundRepairAttemptSnapshot(input)) {
        throw new TypeError(
            'Stored AL outbound repair-attempt snapshot does not match the current contract'
        );
    }
    return input;
}

function isALSupersedencePersistenceValue(
    input: JsonWireValue | object
): input is ALSupersedencePersistenceValue {
    if (!isRecord(input)) {
        return false;
    }
    if (input.kind === 'latest') {
        return hasOnlyKeys(input, ['kind', 'latestMsgId', 'latestSeq', 'latestTs', 'updatedAtMs']) &&
            isString(input.latestMsgId) &&
            isOptionalFiniteNumber(input.latestSeq) &&
            isFiniteNumber(input.latestTs) &&
            isFiniteNumber(input.updatedAtMs);
    }
    return input.kind === 'replacement' &&
        hasOnlyKeys(input, ['kind', 'byMsgId', 'updatedAtMs']) &&
        isString(input.byMsgId) &&
        isFiniteNumber(input.updatedAtMs);
}

function isALOutboundPendingAckSnapshot(
    input: JsonWireValue | object
): input is ALOutboundPendingAckSnapshot {
    return isRecord(input) &&
        hasOnlyKeys(input, [
            'msgId',
            'expectedPeerIds',
            'ackedPeerIds',
            'timeoutMs',
            'maxAttempts',
            'attempts',
            'deadlineAtMs'
        ]) &&
        isString(input.msgId) &&
        isStringArray(input.expectedPeerIds) &&
        isStringArray(input.ackedPeerIds) &&
        isFiniteNumber(input.timeoutMs) &&
        isFiniteNumber(input.maxAttempts) &&
        isFiniteNumber(input.attempts) &&
        isFiniteNumber(input.deadlineAtMs);
}

function isALOutboundRepairAttemptSnapshot(
    input: JsonWireValue | object
): input is ALOutboundRepairAttemptSnapshot {
    return isRecord(input) &&
        hasOnlyKeys(input, ['msgId', 'attempts']) &&
        isString(input.msgId) &&
        isFiniteNumber(input.attempts);
}
