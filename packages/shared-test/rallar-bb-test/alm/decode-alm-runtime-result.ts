import type { ALReceiptMode } from '@shared/al-contracts/al-policy.ts';
import {
    AL_DELIVERY_STATES,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryAttemptOutcome,
    type ALDeliveryCarrier,
    type ALDeliveryRelayRejection,
    type ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type {
    RallarBlackBoxTestMessagesCarrier,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES } from '../schema/rallar-black-box-command-fields.ts';
import type {
    RallarBlackBoxTestMessagesControlResultValue,
    RallarBlackBoxTestMessagesObserveResultValue,
    RallarBlackBoxTestMessagesReplayResultValue,
    RallarBlackBoxTestMessagesSendResultValue,
    RallarBlackBoxTestStorageCountersResultValue
} from './rallar-black-box-alm-result-values.ts';

/** The error name a page-runtime result that fails these decoders carries. */
export const ALM_INVALID_RUNTIME_RESULT_CODE = 'RALLAR_BLACK_BOX_ALM_INVALID_RUNTIME_RESULT';

const ALM_MESSAGES_CARRIERS: readonly RallarBlackBoxTestMessagesCarrier[] = [
    'ws',
    'rtc',
    'rtc-with-ws-fallback'
];

/** Keyed by every receipt mode, so a new mode fails to compile here instead of decoding as an invalid result. */
const ALM_RECEIPT_MODES: Readonly<Record<ALReceiptMode, true>> = { hop: true, subtree: true, receiver: true };

/** Every value an observation may carry as its receipt mode: none before a receipt settles, or a known mode. */
const ALM_RECEIPT_MODE_FIELD_VALUES: readonly (ALReceiptMode | undefined)[] = [
    undefined,
    ...Object.keys(ALM_RECEIPT_MODES) as ALReceiptMode[]
];

/** Keyed by every verdict kind, so a new kind fails to compile here instead of decoding as an invalid result. */
const ALM_ADMISSION_VERDICT_KINDS: Readonly<Record<ALDeliveryAdmissionVerdict['kind'], true>> = {
    admitted: true,
    duplicate: true,
    pending: true,
    deferred: true,
    refused: true,
    unroutable: true,
    superseded: true,
    expired: true,
    skipped: true,
    failed: true
};

/** Keyed by every attempt outcome, so a new outcome fails to compile here instead of decoding as invalid. */
const ALM_ATTEMPT_OUTCOMES: Readonly<Record<ALDeliveryAttemptOutcome, true>> = {
    sent: true,
    'not-ready': true,
    failed: true,
    'no-targets': true,
    cancelled: true,
    expired: true,
    superseded: true,
    unroutable: true,
    refused: true
};

export function decodeAlmMessagesSendResultValue(
    value: unknown
): RallarBlackBoxTestMessagesSendResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'messages.send result';
    const msgId = readAlmOptionalStringField(record, path, 'msgId');
    const reason = readAlmOptionalStringField(record, path, 'reason');
    return {
        handleId: requireAlmStringField(record, path, 'handleId'),
        ...(msgId === undefined ? {} : { msgId }),
        carrier: requireAlmCarrierField(record, path),
        status: requireAlmDeliveryState(record, path, 'status'),
        ...(reason === undefined ? {} : { reason })
    };
}

export function decodeAlmMessagesReplayResultValue(value: unknown): RallarBlackBoxTestMessagesReplayResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'messages.send replay result';
    const carrier = requireAlmCarrierLegField(record, path);
    const verdict = record.verdict;
    if (!isAlmAdmissionVerdictKind(verdict)) {
        throw toAlmInvalidRuntimeResultError(`${path}.verdict`);
    }
    const reason = readAlmOptionalStringField(record, path, 'reason');
    return {
        handleId: requireAlmStringField(record, path, 'handleId'),
        msgId: requireAlmStringField(record, path, 'msgId'),
        carrier,
        verdict,
        ...(reason === undefined ? {} : { reason })
    };
}

export function decodeAlmMessagesControlResultValue(value: unknown): RallarBlackBoxTestMessagesControlResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'messages.control result';
    const carrier = requireAlmCarrierLegField(record, path);
    const verdict = record.verdict;
    if (!isAlmAdmissionVerdictKind(verdict)) {
        throw toAlmInvalidRuntimeResultError(`${path}.verdict`);
    }
    const reason = readAlmOptionalStringField(record, path, 'reason');
    return {
        msgId: requireAlmStringField(record, path, 'msgId'),
        typeId: requireAlmStringField(record, path, 'typeId'),
        carrier,
        verdict,
        ...(reason === undefined ? {} : { reason })
    };
}

function isAlmAdmissionVerdictKind(value: unknown): value is ALDeliveryAdmissionVerdict['kind'] {
    return typeof value === 'string' && Object.hasOwn(ALM_ADMISSION_VERDICT_KINDS, value);
}

export function decodeAlmDeliveryResultValue(
    value: unknown
): RallarBlackBoxTestMessagesObserveResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'delivery observation';
    return {
        handleId: requireAlmStringField(record, path, 'handleId'),
        state: requireAlmDeliveryState(record, path, 'state'),
        submitted: requireAlmBooleanField(record, path, 'submitted'),
        enqueued: requireAlmBooleanField(record, path, 'enqueued'),
        receiptMode: readAlmReceiptModeField(record, path),
        relayRejection: readAlmRelayRejectionField(record, path),
        confirmedHopPeerIds: requireAlmStringListField(record, path, 'confirmedHopPeerIds'),
        unconfirmedHopPeerIds: requireAlmStringListField(record, path, 'unconfirmedHopPeerIds'),
        expectedRecipientPeerIds: requireAlmStringListField(record, path, 'expectedRecipientPeerIds'),
        confirmedRecipientPeerIds: requireAlmStringListField(record, path, 'confirmedRecipientPeerIds'),
        unconfirmedRecipientPeerIds: requireAlmStringListField(record, path, 'unconfirmedRecipientPeerIds'),
        attempts: requireAlmNumberField(record, path, 'attempts'),
        attemptOutcomes: requireAlmAttemptOutcomesField(record, path),
        reason: readAlmOptionalStringField(record, path, 'reason')
    };
}

export function decodeAlmStorageCountersResultValue(
    value: unknown
): RallarBlackBoxTestStorageCountersResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'storage.counters result';
    const byOwner = requireAlmRecordField(record, path, 'byOwner');
    return {
        total: requireAlmNumberField(record, path, 'total'),
        byOwner: {
            'al-admission': requireAlmNumberField(byOwner, `${path}.byOwner`, 'al-admission'),
            'al-work': requireAlmNumberField(byOwner, `${path}.byOwner`, 'al-work')
        },
        byKind: requireAlmCountsByKind(requireAlmRecordField(record, path, 'byKind'), `${path}.byKind`)
    };
}

export function decodeAlmRuntimeRecord(value: unknown): RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null
        ? value as RallarBlackBoxTestRecord
        : {};
}

function requireAlmCountsByKind(
    record: RallarBlackBoxTestRecord,
    path: string
): Readonly<Record<string, number>> {
    return Object.fromEntries(
        Object.keys(record).map((key) => [key, requireAlmNumberField(record, path, key)])
    );
}

function requireAlmCarrierField(
    record: RallarBlackBoxTestRecord,
    path: string
): RallarBlackBoxTestMessagesCarrier {
    const carrier = ALM_MESSAGES_CARRIERS.find((candidate) => candidate === record.carrier);
    if (carrier === undefined) {
        throw toAlmInvalidRuntimeResultError(`${path}.carrier`);
    }
    return carrier;
}

function requireAlmCarrierLegField(record: RallarBlackBoxTestRecord, path: string): ALDeliveryCarrier {
    const carrier = RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesCarrierLeg.find((candidate) =>
        candidate === record.carrier
    );
    if (carrier === undefined) {
        throw toAlmInvalidRuntimeResultError(`${path}.carrier`);
    }
    return carrier;
}

function requireAlmStringField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): string {
    const value = record[key];
    if (typeof value !== 'string') {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value;
}

function readAlmOptionalStringField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): string | undefined {
    const value = record[key];
    if (value === undefined || typeof value === 'string') {
        return value;
    }
    throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
}

/** Absent until a receipt settles: a send that tracks no receipt never names a mode. */
function readAlmReceiptModeField(record: RallarBlackBoxTestRecord, path: string): ALReceiptMode | undefined {
    if (!ALM_RECEIPT_MODE_FIELD_VALUES.some((candidate) => candidate === record.receiptMode)) {
        throw toAlmInvalidRuntimeResultError(`${path}.receiptMode`);
    }
    return record.receiptMode as ALReceiptMode | undefined;
}

/** Absent unless a hop refused the message; a trusted server relay is never named, so an id on one is refused. */
function readAlmRelayRejectionField(
    record: RallarBlackBoxTestRecord,
    path: string
): ALDeliveryRelayRejection | undefined {
    const value = record.relayRejection;
    if (value === undefined) {
        return undefined;
    }
    const rejection = decodeAlmRuntimeRecord(value);
    if (
        rejection.reason === 'resync-required' && rejection.relay === 'trusted-server' && rejection.peerId === undefined
    ) {
        return { relay: 'trusted-server', reason: 'resync-required' };
    }
    if (rejection.reason === 'resync-required' && rejection.relay === 'peer' && typeof rejection.peerId === 'string') {
        return { relay: 'peer', peerId: rejection.peerId, reason: 'resync-required' };
    }
    throw toAlmInvalidRuntimeResultError(`${path}.relayRejection`);
}

function requireAlmAttemptOutcomesField(
    record: RallarBlackBoxTestRecord,
    path: string
): readonly ALDeliveryAttemptOutcome[] {
    const outcomes = requireAlmStringListField(record, path, 'attemptOutcomes');
    if (!outcomes.every((outcome) => Object.hasOwn(ALM_ATTEMPT_OUTCOMES, outcome))) {
        throw toAlmInvalidRuntimeResultError(`${path}.attemptOutcomes`);
    }
    return outcomes as readonly ALDeliveryAttemptOutcome[];
}

function requireAlmNumberField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): number {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value;
}

function requireAlmBooleanField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): boolean {
    const value = record[key];
    if (typeof value !== 'boolean') {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value;
}

function requireAlmStringListField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): readonly string[] {
    const value = record[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value as readonly string[];
}

function requireAlmRecordField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): RallarBlackBoxTestRecord {
    const value = record[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value as RallarBlackBoxTestRecord;
}

function toAlmInvalidRuntimeResultError(field: string): Error {
    const error = new Error(`The page runtime returned no usable ${field}.`);
    error.name = ALM_INVALID_RUNTIME_RESULT_CODE;
    return error;
}

function requireAlmDeliveryState(record: RallarBlackBoxTestRecord, path: string, key: string): ALDeliveryState {
    const state = AL_DELIVERY_STATES.find((candidate) => candidate === record[key]);
    if (state === undefined) {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return state;
}
