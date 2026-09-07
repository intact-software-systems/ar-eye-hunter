import type {
    ALAckPayload,
    ALAckStatus,
    ALNackPayload,
    ALNackReason,
    ALPendingAckSnapshot,
    ALRepairPayload,
    ALRepairReason
} from './al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from './al-message-resource-limits.ts';

export function decodeALAckPayload(value: unknown): ALAckPayload {
    const record = decodeControlRecord(value, [
        'ackedMsgId',
        'fromPeerId',
        'toPeerId',
        'status',
        'observedAtEpochMs'
    ]);
    return {
        ackedMsgId: decodeControlIdentifier(record.ackedMsgId, 'ACK message ID'),
        fromPeerId: decodeControlIdentifier(record.fromPeerId, 'ACK sender identity'),
        toPeerId: decodeControlIdentifier(record.toPeerId, 'ACK receiver identity'),
        status: decodeAckStatus(record.status),
        observedAtEpochMs: decodeControlNumber(record.observedAtEpochMs, 'ACK observation time')
    };
}

export function decodeALNackPayload(value: unknown): ALNackPayload {
    const record = decodeControlRecord(
        value,
        ['msgId', 'fromPeerId', 'toPeerId', 'reason', 'observedAtEpochMs'],
        ['orderingKey', 'expectedSeq', 'missingSeqs', 'serverSnapshotVersion']
    );
    return {
        ...decodeControlRoute(record, 'NACK'),
        reason: decodeNackReason(record.reason),
        ...decodeOptionalIdentifier(record, 'orderingKey', 'NACK ordering key'),
        ...decodeOptionalNumber(record, 'expectedSeq', 'NACK expected sequence'),
        ...decodeOptionalNumberArray(record, 'missingSeqs', 'NACK missing sequences'),
        ...decodeOptionalNumber(record, 'serverSnapshotVersion', 'NACK server snapshot version')
    };
}

export function decodeALRepairPayload(value: unknown): ALRepairPayload {
    const record = decodeControlRecord(
        value,
        ['msgId', 'fromPeerId', 'toPeerId', 'reason', 'observedAtEpochMs'],
        ['orderingKey', 'expectedSeq', 'missingSeqs']
    );
    return {
        ...decodeControlRoute(record, 'repair'),
        reason: decodeRepairReason(record.reason),
        ...decodeOptionalIdentifier(record, 'orderingKey', 'repair ordering key'),
        ...decodeOptionalNumber(record, 'expectedSeq', 'repair expected sequence'),
        ...decodeOptionalNumberArray(record, 'missingSeqs', 'repair missing sequences')
    };
}

export function decodeALPendingAckSnapshot(value: unknown): ALPendingAckSnapshot {
    const record = decodeControlRecord(
        value,
        ['toPeerId', 'status', 'localReady', 'expectedFromPeerIds', 'ackedFromPeerIds'],
        ['expireAtTimestamp']
    );
    if (typeof record.localReady !== 'boolean') {
        throw new TypeError('Pending ACK readiness is invalid');
    }
    return {
        toPeerId: decodeControlIdentifier(record.toPeerId, 'pending ACK receiver identity'),
        status: decodeAckStatus(record.status),
        localReady: record.localReady,
        expectedFromPeerIds: decodeControlIdentifierArray(
            record.expectedFromPeerIds,
            'pending ACK expected peer identity'
        ),
        ackedFromPeerIds: decodeControlIdentifierArray(
            record.ackedFromPeerIds,
            'pending ACK acknowledged peer identity'
        ),
        ...decodeOptionalNumber(record, 'expireAtTimestamp', 'pending ACK expiry')
    };
}

interface ControlRecord {
    readonly [key: string]: unknown;
}

function decodeControlRecord(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = []
): ControlRecord {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError('Control value must be a plain record');
    }
    const allowed = [...required, ...optional];
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !allowed.includes(key)) {
            throw new TypeError('Control value has unknown fields');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('Control fields must be enumerable data properties');
        }
        keys.push(key);
    }
    if (required.some((key) => !keys.includes(key))) {
        throw new TypeError('Control value is missing mandatory fields');
    }
    return value as ControlRecord;
}

function decodeControlRoute(
    record: ControlRecord,
    label: string
): Pick<ALNackPayload, 'msgId' | 'fromPeerId' | 'toPeerId' | 'observedAtEpochMs'> {
    return {
        msgId: decodeControlIdentifier(record.msgId, `${label} message ID`),
        fromPeerId: decodeControlIdentifier(record.fromPeerId, `${label} sender identity`),
        toPeerId: decodeControlIdentifier(record.toPeerId, `${label} receiver identity`),
        observedAtEpochMs: decodeControlNumber(record.observedAtEpochMs, `${label} observation time`)
    };
}

function decodeControlIdentifier(value: unknown, label: string): string {
    if (
        typeof value !== 'string' || value.length === 0 ||
        value.length > AL_MESSAGE_RESOURCE_LIMITS.routeIdCharacters
    ) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function decodeControlNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function decodeOptionalIdentifier(
    record: ControlRecord,
    key: string,
    label: string
): Readonly<Record<string, string>> {
    return Object.hasOwn(record, key) ? { [key]: decodeControlIdentifier(record[key], label) } : {};
}

function decodeOptionalNumber(
    record: ControlRecord,
    key: string,
    label: string
): Readonly<Record<string, number>> {
    return Object.hasOwn(record, key) ? { [key]: decodeControlNumber(record[key], label) } : {};
}

function decodeOptionalNumberArray(
    record: ControlRecord,
    key: string,
    label: string
): Readonly<Record<string, readonly number[]>> {
    return Object.hasOwn(record, key) ? { [key]: decodeControlNumberArray(record[key], label) } : {};
}

function decodeControlIdentifierArray(value: unknown, label: string): readonly string[] {
    const entries = readControlArrayEntries(value, AL_MESSAGE_RESOURCE_LIMITS.collectionEntries, label);
    const result: string[] = [];
    for (const entry of entries) {
        result.push(decodeControlIdentifier(entry, label));
    }
    return result;
}

function decodeControlNumberArray(value: unknown, label: string): readonly number[] {
    const entries = readControlArrayEntries(value, AL_MESSAGE_RESOURCE_LIMITS.repairWindow, label);
    const result: number[] = [];
    for (const entry of entries) {
        result.push(decodeControlNumber(entry, label));
    }
    return result;
}

function readControlArrayEntries(value: unknown, limit: number, label: string): readonly unknown[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit) {
        throw new TypeError(`${label} is invalid or exceeds its entry limit`);
    }
    const result: unknown[] = [];
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) {
        throw new TypeError(`${label} must contain dense data entries`);
    }
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} must contain dense data entries`);
        }
        result.push(descriptor.value);
    }
    return result;
}

function decodeAckStatus(value: unknown): ALAckStatus {
    if (value !== 'accepted' && value !== 'delivered' && value !== 'forwarded' && value !== 'subtree-complete') {
        throw new TypeError('Control ACK status is invalid');
    }
    return value;
}

function decodeNackReason(value: unknown): ALNackReason {
    if (
        value !== 'duplicate' && value !== 'gap' && value !== 'resync-required' && value !== 'expired' &&
        value !== 'unauthorized' && value !== 'no-route' && value !== 'overloaded' && value !== 'stale' &&
        value !== 'not-yet-in-sync'
    ) {
        throw new TypeError('Control NACK reason is invalid');
    }
    return value;
}

function decodeRepairReason(value: unknown): ALRepairReason {
    if (value !== 'missing-seq' && value !== 'retransmit' && value !== 'resync') {
        throw new TypeError('Control repair reason is invalid');
    }
    return value;
}
