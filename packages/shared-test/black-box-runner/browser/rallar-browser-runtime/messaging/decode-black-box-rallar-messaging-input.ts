import { AL_DELIVERY_STATES, type ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { Either } from '@shared/resilience/Either.ts';
import type {
    ScriptedTransportFault,
    TransportFaultCarrier,
    TransportFaultMatch
} from '@shared/transport-faults/transport-fault-port.ts';

import type {
    BlackBoxRallarDeliveryHandleInput,
    BlackBoxRallarDeliveryObserveInput,
    BlackBoxRallarStorageCountersInput
} from '../black-box-rallar-operation-contracts.ts';
import {
    decodeBlackBoxCommandNumber,
    decodeBlackBoxCommandString,
    isBlackBoxCommandRecord,
    type BlackBoxRallarInputIssue
} from '../decode-black-box-rallar-command-input.ts';

const FAULT_CARRIERS: readonly TransportFaultCarrier[] = ['ws', 'rtc'];
const FAULT_CONTROL_TYPES: readonly NonNullable<TransportFaultMatch['controlType']>[] = ['ack', 'nack', 'repair'];

/** The RTC data channel treats a delay decision as pass, so arming one there would be inert. */
const FAULT_RTC_DELAY_UNSUPPORTED_MESSAGE = 'fault.inject.action must be "drop" on the rtc carrier.';

export function decodeBlackBoxRallarDeliveryHandleInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarDeliveryHandleInput> {
    if (!isBlackBoxCommandRecord(value)) {
        return toInputIssue('delivery handle input must be an object.');
    }
    const connection = decodeBlackBoxCommandString(value.connection);
    if (connection === undefined) {
        return toInputIssue('delivery handle connection is required.');
    }
    const handleId = decodeBlackBoxCommandString(value.handleId);
    return handleId === undefined
        ? toInputIssue('delivery handle handleId is required.')
        : Either.ofRight({ connection, handleId });
}

export function decodeBlackBoxRallarDeliveryObserveInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarDeliveryObserveInput> {
    if (!isBlackBoxCommandRecord(value)) {
        return toInputIssue('messages.observe input must be an object.');
    }
    return decodeBlackBoxRallarDeliveryHandleInput(value).flatMap(
        (issue) => Either.ofLeft(issue),
        (handle) => {
            const state = value.state;
            if (!isDeliveryStateList(state)) {
                return toInputIssue(
                    `messages.observe.state must list at least one of ${AL_DELIVERY_STATES.join(', ')}.`
                );
            }
            const timeoutMs = decodeBlackBoxCommandNumber(value.timeoutMs);
            return timeoutMs === undefined
                ? toInputIssue('messages.observe.timeoutMs is required.')
                : Either.ofRight({ ...handle, state, timeoutMs });
        }
    );
}

export function decodeBlackBoxRallarFaultInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, ScriptedTransportFault> {
    if (!isBlackBoxCommandRecord(value)) {
        return toInputIssue('fault.inject input must be an object.');
    }
    const carrier = value.carrier;
    if (!isFaultCarrier(carrier)) {
        return toInputIssue('fault.inject.carrier must be ws or rtc.');
    }
    return decodeFaultAction(value.action).flatMap(
        (issue) => Either.ofLeft(issue),
        (action) => {
            if (carrier === 'rtc' && action !== 'drop') {
                return toInputIssue(FAULT_RTC_DELAY_UNSUPPORTED_MESSAGE);
            }
            const faultId = decodeBlackBoxCommandString(value.faultId);
            if (faultId === undefined) {
                return toInputIssue('fault.inject.faultId is required.');
            }
            return decodeFaultMatch(value.match).flatMap(
                (issue) => Either.ofLeft(issue),
                (match) =>
                    decodeFaultRemaining(value.remaining).mapRight((remaining) => ({
                        faultId,
                        carrier,
                        match,
                        action,
                        remaining
                    }))
            );
        }
    );
}

export function decodeBlackBoxRallarStorageCountersInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarStorageCountersInput> {
    if (value === undefined || value === null) {
        return Either.ofRight({ reset: false });
    }
    if (!isBlackBoxCommandRecord(value)) {
        return toInputIssue('storage.counters input must be an object.');
    }
    const reset = value.reset;
    return reset === undefined || typeof reset === 'boolean'
        ? Either.ofRight({ reset: reset === true })
        : toInputIssue('storage.counters.reset must be a boolean.');
}

function decodeFaultAction(value: unknown): Either<BlackBoxRallarInputIssue, ScriptedTransportFault['action']> {
    if (value === 'drop' || value === 'not-ready') {
        return Either.ofRight(value);
    }
    const delayMs = isBlackBoxCommandRecord(value) ? decodeBlackBoxCommandNumber(value.delayMs) : undefined;
    return delayMs === undefined
        ? toInputIssue('fault.inject.action must be "drop", "not-ready" or an object naming delayMs.')
        : Either.ofRight({ delayMs });
}

function decodeFaultRemaining(value: unknown): Either<BlackBoxRallarInputIssue, ScriptedTransportFault['remaining']> {
    if (value === 'until-cleared') {
        return Either.ofRight(value);
    }
    const numericInput = typeof value === 'string' ? decodeBlackBoxCommandString(value) : value;
    const remaining = decodeBlackBoxCommandNumber(numericInput);
    return remaining === undefined
        ? toInputIssue('fault.inject.remaining is required.')
        : Either.ofRight(remaining);
}

function decodeFaultMatch(value: unknown): Either<BlackBoxRallarInputIssue, TransportFaultMatch> {
    if (!isBlackBoxCommandRecord(value)) {
        return toInputIssue('fault.inject.match must be an object.');
    }
    const controlType = value.controlType ?? undefined;
    const knownControlType = FAULT_CONTROL_TYPES.find((candidate) => candidate === controlType);
    if (controlType !== undefined && knownControlType === undefined) {
        return toInputIssue('fault.inject.match.controlType must be ack, nack, or repair.');
    }
    return Either.ofRight({
        controlType: knownControlType,
        typeId: decodeBlackBoxCommandString(value.typeId),
        msgId: decodeBlackBoxCommandString(value.msgId)
    });
}

function isDeliveryStateList(value: unknown): value is readonly ALDeliveryState[] {
    return Array.isArray(value) && value.length > 0 &&
        value.every((entry) => AL_DELIVERY_STATES.some((state) => state === entry));
}

function isFaultCarrier(value: unknown): value is TransportFaultCarrier {
    return typeof value === 'string' && FAULT_CARRIERS.some((carrier) => carrier === value);
}

function toInputIssue<T>(message: string): Either<BlackBoxRallarInputIssue, T> {
    return Either.ofLeft({ message });
}
