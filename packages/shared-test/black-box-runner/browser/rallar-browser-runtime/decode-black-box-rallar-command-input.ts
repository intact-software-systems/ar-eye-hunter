import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import type {
    ScriptedTransportFault,
    TransportFaultCarrier,
    TransportFaultMatch
} from '@shared/transport-faults/transport-fault-port.ts';

import type {
    BlackBoxRallarDeliveryHandleInput,
    BlackBoxRallarDeliveryObserveInput,
    BlackBoxRallarMessageSendInput,
    BlackBoxRallarRoomRef,
    BlackBoxRallarScope,
    BlackBoxRallarSendInput,
    BlackBoxRallarStorageCountersInput,
    BlackBoxRallarTransport
} from './black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarWsSendInput } from './black-box-rallar-runtime-contract.ts';

export function isBlackBoxCommandRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeBlackBoxCommandString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function decodeBlackBoxCommandNumber(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
    return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

export function decodeBlackBoxCommandScope(value: unknown): BlackBoxRallarScope | undefined {
    if (!isBlackBoxCommandRecord(value)) {
        return undefined;
    }
    return {
        applicationId: decodeBlackBoxCommandString(value.applicationId),
        workspaceId: decodeBlackBoxCommandString(value.workspaceId)
    };
}

export function decodeBlackBoxCommandRoomRef(value: unknown): BlackBoxRallarRoomRef | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isBlackBoxCommandRecord(value)) {
        throw new Error('Rallar command roomRef must be an object.');
    }
    const applicationId = decodeBlackBoxCommandString(value.applicationId);
    const groupId = decodeBlackBoxCommandString(value.groupId);
    if (!applicationId || !groupId) {
        throw new Error('Rallar command roomRef requires applicationId and groupId.');
    }
    return { applicationId, groupId, workspaceId: decodeBlackBoxCommandString(value.workspaceId) };
}

function decodePeerIds(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')
        ? value
        : undefined;
}

function decodeAck(value: unknown): ALAckMode | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value === 'none' || value === 'receiver' || value === 'all-logical-recipients' || value === 'group-leader') {
        return value;
    }
    throw new Error('Rallar command ack mode is invalid.');
}

function decodeMessageFields(record: Record<string, unknown>): BlackBoxRallarSendInput {
    return {
        ...('payload' in record ? { payload: record.payload } : {}),
        ...('data' in record ? { data: record.data } : {}),
        roomId: decodeBlackBoxCommandString(record.roomId),
        roomRef: decodeBlackBoxCommandRoomRef(record.roomRef),
        applicationId: decodeBlackBoxCommandString(record.applicationId),
        workspaceId: decodeBlackBoxCommandString(record.workspaceId),
        scope: decodeBlackBoxCommandScope(record.scope),
        typeId: decodeBlackBoxCommandString(record.typeId),
        topicId: decodeBlackBoxCommandString(record.topicId),
        contextId: decodeBlackBoxCommandString(record.contextId),
        resourceId: decodeBlackBoxCommandString(record.resourceId),
        ttlHops: decodeBlackBoxCommandNumber(record.ttlHops),
        ttlMs: decodeBlackBoxCommandNumber(record.ttlMs),
        reliability: record.reliability === 'best-effort' || record.reliability === 'at-least-once'
            ? record.reliability
            : undefined,
        ack: decodeAck(record.ack),
        ownership: record.ownership === 'shared' || record.ownership === 'exclusive' ? record.ownership : undefined,
        minSnapshotVersion: decodeBlackBoxCommandNumber(record.minSnapshotVersion)
    };
}

function isRealtimeSendEnvelope(input: Record<string, unknown>): boolean {
    return [
        'data',
        'laneId',
        'roomId',
        'roomRef',
        'applicationId',
        'workspaceId',
        'scope',
        'peerIds',
        'nextHopPeerIds',
        'remotePeerId',
        'typeId',
        'topicId',
        'contextId',
        'resourceId'
    ]
        .some((field) => field in input);
}

export function decodeBlackBoxRallarSendInput(
    input: unknown,
    transport: BlackBoxRallarTransport
): BlackBoxRallarSendInput {
    if (!isBlackBoxCommandRecord(input) || (transport === 'realtime' && !isRealtimeSendEnvelope(input))) {
        return transport === 'realtime' ? { data: input } : { payload: input };
    }
    return {
        ...decodeMessageFields(input),
        laneId: decodeBlackBoxCommandString(input.laneId),
        peerIds: decodePeerIds(input.peerIds),
        nextHopPeerIds: decodePeerIds(input.nextHopPeerIds),
        remotePeerId: decodeBlackBoxCommandString(input.remotePeerId),
        membershipEpoch: decodeBlackBoxCommandNumber(input.membershipEpoch),
        seq: decodeBlackBoxCommandNumber(input.seq),
        orderingKey: decodeBlackBoxCommandString(input.orderingKey),
        overlayId: decodeBlackBoxCommandString(input.overlayId),
        fanoutLimit: decodeBlackBoxCommandNumber(input.fanoutLimit),
        openTimeoutMs: decodeBlackBoxCommandNumber(input.openTimeoutMs),
        key: decodeBlackBoxCommandString(input.key),
        maxAgeMs: decodeBlackBoxCommandNumber(input.maxAgeMs)
    };
}

export function decodeBlackBoxRallarWsSendInput(input: unknown): BlackBoxRallarWsSendInput {
    if (!isBlackBoxCommandRecord(input)) {
        return { payload: input };
    }
    return {
        ...decodeMessageFields(input),
        scope: input.scope === 'room' || input.scope === 'world' || input.scope === 'all' ? input.scope : undefined,
        groupId: decodeBlackBoxCommandString(input.groupId),
        topic: decodeBlackBoxCommandString(input.topic),
        kind: decodeBlackBoxCommandString(input.kind),
        exceptPeerIds: decodePeerIds(input.exceptPeerIds)
    };
}

function decodeRequiredBlackBoxCommandRecord(value: unknown, field: string): Record<string, unknown> {
    if (!isBlackBoxCommandRecord(value)) {
        throw new TypeError(`${field} must be an object.`);
    }
    return value;
}

function decodeRequiredBlackBoxCommandString(value: unknown, field: string): string {
    const decoded = decodeBlackBoxCommandString(value);
    if (decoded === undefined) {
        throw new TypeError(`${field} is required.`);
    }
    return decoded;
}

function decodeRequiredBlackBoxCommandNumber(value: unknown, field: string): number {
    const decoded = decodeBlackBoxCommandNumber(value);
    if (decoded === undefined) {
        throw new TypeError(`${field} is required.`);
    }
    return decoded;
}

function decodeMessageCarrier(value: unknown): BlackBoxRallarMessageSendInput['carrier'] {
    if (value === 'ws' || value === 'rtc' || value === 'rtc-with-ws-fallback') {
        return value;
    }
    throw new TypeError('messages.send.carrier must be ws, rtc, or rtc-with-ws-fallback.');
}

function decodeMessageScope(value: unknown): BlackBoxRallarMessageSendInput['scope'] {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (value === 'room' || value === 'world' || value === 'all') {
        return value;
    }
    throw new TypeError('messages.send.scope must be room, world, or all.');
}

function rejectUnsupportedMessageField(record: Record<string, unknown>, field: string): void {
    if (record[field] !== undefined) {
        throw new TypeError(`messages.send.${field} is not supported by this runtime release`);
    }
}

export function decodeBlackBoxRallarMessageSendInput(value: unknown): BlackBoxRallarMessageSendInput {
    const record = decodeRequiredBlackBoxCommandRecord(value, 'messages.send input');
    rejectUnsupportedMessageField(record, 'key');
    rejectUnsupportedMessageField(record, 'toPeerId');
    if (!('payload' in record)) {
        throw new TypeError('messages.send.payload is required.');
    }
    return {
        connection: decodeRequiredBlackBoxCommandString(record.connection, 'messages.send.connection'),
        carrier: decodeMessageCarrier(record.carrier),
        typeId: decodeRequiredBlackBoxCommandString(record.typeId, 'messages.send.typeId'),
        topicId: decodeBlackBoxCommandString(record.topicId),
        payload: record.payload,
        roomRef: decodeBlackBoxCommandRoomRef(record.roomRef),
        scope: decodeMessageScope(record.scope),
        reliability: record.reliability === 'best-effort' || record.reliability === 'at-least-once'
            ? record.reliability
            : undefined,
        ack: decodeAck(record.ack),
        ttlMs: decodeBlackBoxCommandNumber(record.ttlMs),
        orderingKey: decodeBlackBoxCommandString(record.orderingKey),
        seq: decodeBlackBoxCommandNumber(record.seq),
        handleId: decodeRequiredBlackBoxCommandString(record.handleId, 'messages.send.handleId')
    };
}

export function decodeBlackBoxRallarDeliveryHandleInput(value: unknown): BlackBoxRallarDeliveryHandleInput {
    const record = decodeRequiredBlackBoxCommandRecord(value, 'delivery handle input');
    return {
        connection: decodeRequiredBlackBoxCommandString(record.connection, 'delivery handle connection'),
        handleId: decodeRequiredBlackBoxCommandString(record.handleId, 'delivery handle handleId')
    };
}

function decodeDeliveryStates(value: unknown): readonly string[] {
    if (
        !Array.isArray(value) || value.length === 0 ||
        !value.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    ) {
        throw new TypeError('messages.observe.state must list at least one delivery state.');
    }
    return value;
}

export function decodeBlackBoxRallarDeliveryObserveInput(value: unknown): BlackBoxRallarDeliveryObserveInput {
    const record = decodeRequiredBlackBoxCommandRecord(value, 'messages.observe input');
    return {
        ...decodeBlackBoxRallarDeliveryHandleInput(record),
        state: decodeDeliveryStates(record.state),
        timeoutMs: decodeRequiredBlackBoxCommandNumber(record.timeoutMs, 'messages.observe.timeoutMs')
    };
}

function decodeFaultCarrier(value: unknown): TransportFaultCarrier {
    if (value === 'ws' || value === 'rtc') {
        return value;
    }
    throw new TypeError('fault.inject.carrier must be ws or rtc.');
}

function decodeFaultControlType(value: unknown): TransportFaultMatch['controlType'] {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (value === 'ack' || value === 'nack' || value === 'repair') {
        return value;
    }
    throw new TypeError('fault.inject.match.controlType must be ack, nack, or repair.');
}

function decodeFaultMatch(value: unknown): TransportFaultMatch {
    const record = decodeRequiredBlackBoxCommandRecord(value, 'fault.inject.match');
    return {
        controlType: decodeFaultControlType(record.controlType),
        typeId: decodeBlackBoxCommandString(record.typeId),
        msgId: decodeBlackBoxCommandString(record.msgId)
    };
}

function decodeFaultAction(value: unknown): ScriptedTransportFault['action'] {
    if (value === 'drop') {
        return 'drop';
    }
    const delayMs = isBlackBoxCommandRecord(value) ? decodeBlackBoxCommandNumber(value.delayMs) : undefined;
    if (delayMs === undefined) {
        throw new TypeError('fault.inject.action must be "drop" or an object naming delayMs.');
    }
    return { delayMs };
}

export function decodeBlackBoxRallarFaultInput(value: unknown): ScriptedTransportFault {
    const record = decodeRequiredBlackBoxCommandRecord(value, 'fault.inject input');
    return {
        faultId: decodeRequiredBlackBoxCommandString(record.faultId, 'fault.inject.faultId'),
        carrier: decodeFaultCarrier(record.carrier),
        match: decodeFaultMatch(record.match),
        action: decodeFaultAction(record.action),
        remaining: decodeRequiredBlackBoxCommandNumber(record.remaining, 'fault.inject.remaining')
    };
}

export function decodeBlackBoxRallarStorageCountersInput(value: unknown): BlackBoxRallarStorageCountersInput {
    if (value === undefined || value === null) {
        return { reset: false };
    }
    const record = decodeRequiredBlackBoxCommandRecord(value, 'storage.counters input');
    if (record.reset !== undefined && typeof record.reset !== 'boolean') {
        throw new TypeError('storage.counters.reset must be a boolean.');
    }
    return { reset: record.reset === true };
}
