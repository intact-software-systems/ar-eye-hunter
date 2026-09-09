import type {
    ScriptedTransportFault,
    TransportFaultCarrier,
    TransportFaultMatch
} from '@shared/transport-faults/transport-fault-port.ts';

import type {
    BlackBoxRallarDeliveryHandleInput,
    BlackBoxRallarDeliveryObserveInput,
    BlackBoxRallarMessageSendInput,
    BlackBoxRallarStorageCountersInput
} from '../black-box-rallar-operation-contracts.ts';
import {
    decodeBlackBoxCommandAck,
    decodeBlackBoxCommandNumber,
    decodeBlackBoxCommandRoomRef,
    decodeBlackBoxCommandString,
    isBlackBoxCommandRecord,
    type BlackBoxRallarCommandRecord
} from '../decode-black-box-rallar-command-input.ts';

const MESSAGE_CARRIERS: readonly string[] = ['ws', 'rtc', 'rtc-with-ws-fallback'];
const MESSAGE_SCOPES: readonly string[] = ['room', 'world', 'all'];
const MESSAGE_RELIABILITIES: readonly string[] = ['best-effort', 'at-least-once'];
const FAULT_CARRIERS: readonly string[] = ['ws', 'rtc'];
const FAULT_CONTROL_TYPES: readonly string[] = ['ack', 'nack', 'repair'];

/** The RTC data channel treats a delay decision as pass, so arming one there would be inert. */
export const FAULT_RTC_DELAY_UNSUPPORTED_MESSAGE = 'fault.inject.action must be "drop" on the rtc carrier.';

const DELIVERY_STATES: readonly string[] = [
    'rejected',
    'accepted',
    'queued',
    'transport-accepted',
    'acknowledged',
    'expired',
    'superseded',
    'failed',
    'cancelled'
];

export function decodeBlackBoxRallarMessageSendInput(value: unknown): BlackBoxRallarMessageSendInput {
    const record = decodeRequiredBlackBoxCommandRecord(value, 'messages.send input');
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
        reliability: decodeMessageReliability(record.reliability),
        ack: decodeBlackBoxCommandAck(record.ack),
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

export function decodeBlackBoxRallarDeliveryObserveInput(value: unknown): BlackBoxRallarDeliveryObserveInput {
    const record = decodeRequiredBlackBoxCommandRecord(value, 'messages.observe input');
    return {
        ...decodeBlackBoxRallarDeliveryHandleInput(record),
        state: decodeDeliveryStates(record.state),
        timeoutMs: decodeRequiredBlackBoxCommandNumber(record.timeoutMs, 'messages.observe.timeoutMs')
    };
}

export function decodeBlackBoxRallarFaultInput(value: unknown): ScriptedTransportFault {
    const record = decodeRequiredBlackBoxCommandRecord(value, 'fault.inject input');
    const carrier = decodeFaultCarrier(record.carrier);
    const action = decodeFaultAction(record.action);
    if (carrier === 'rtc' && action !== 'drop') {
        throw new TypeError(FAULT_RTC_DELAY_UNSUPPORTED_MESSAGE);
    }
    return {
        faultId: decodeRequiredBlackBoxCommandString(record.faultId, 'fault.inject.faultId'),
        carrier,
        match: decodeFaultMatch(record.match),
        action,
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

function decodeMessageCarrier(value: unknown): BlackBoxRallarMessageSendInput['carrier'] {
    if (isMessageCarrier(value)) {
        return value;
    }
    throw new TypeError('messages.send.carrier must be ws, rtc, or rtc-with-ws-fallback.');
}

function decodeMessageScope(value: unknown): BlackBoxRallarMessageSendInput['scope'] {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (isMessageScope(value)) {
        return value;
    }
    throw new TypeError('messages.send.scope must be room, world, or all.');
}

function decodeMessageReliability(value: unknown): BlackBoxRallarMessageSendInput['reliability'] {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (isMessageReliability(value)) {
        return value;
    }
    throw new TypeError('messages.send.reliability must be best-effort or at-least-once.');
}

function decodeDeliveryStates(value: unknown): readonly string[] {
    if (
        !Array.isArray(value) || value.length === 0 ||
        !value.every((entry): entry is string => typeof entry === 'string' && DELIVERY_STATES.includes(entry))
    ) {
        throw new TypeError(
            `messages.observe.state must list at least one of ${DELIVERY_STATES.join(', ')}.`
        );
    }
    return value;
}

function decodeFaultCarrier(value: unknown): TransportFaultCarrier {
    if (isFaultCarrier(value)) {
        return value;
    }
    throw new TypeError('fault.inject.carrier must be ws or rtc.');
}

function decodeFaultControlType(value: unknown): TransportFaultMatch['controlType'] {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (isFaultControlType(value)) {
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

function decodeRequiredBlackBoxCommandRecord(value: unknown, field: string): BlackBoxRallarCommandRecord {
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

function isMessageCarrier(value: unknown): value is BlackBoxRallarMessageSendInput['carrier'] {
    return typeof value === 'string' && MESSAGE_CARRIERS.includes(value);
}

function isMessageScope(value: unknown): value is 'room' | 'world' | 'all' {
    return typeof value === 'string' && MESSAGE_SCOPES.includes(value);
}

function isMessageReliability(value: unknown): value is 'best-effort' | 'at-least-once' {
    return typeof value === 'string' && MESSAGE_RELIABILITIES.includes(value);
}

function isFaultCarrier(value: unknown): value is TransportFaultCarrier {
    return typeof value === 'string' && FAULT_CARRIERS.includes(value);
}

function isFaultControlType(value: unknown): value is 'ack' | 'nack' | 'repair' {
    return typeof value === 'string' && FAULT_CONTROL_TYPES.includes(value);
}
