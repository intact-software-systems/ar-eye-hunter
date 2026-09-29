import type { ALReceiptMode } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
import {
    AL_DELIVERY_STATES,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryAttemptOutcome,
    type ALDeliveryCarrier,
    type ALDeliveryCarrierFallback,
    type ALDeliveryFallbackReason,
    type ALDeliveryRelayRejection,
    type ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type {
    RallarBlackBoxTestMessagesCarrier,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES } from '../schema/rallar-black-box-command-fields.ts';
import { decodeAlmDeliveryFailure, decodeAlmRelayRejection } from './decode-alm-delivery-failure.ts';
import { decodeAlmRuntimeRecord } from './decode-alm-runtime-record.ts';
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

/** Keyed by every fallback reason, so a new reason fails to compile here instead of decoding as an invalid result. */
const ALM_FALLBACK_REASONS: Readonly<Record<ALDeliveryFallbackReason, true>> = {
    'not-ready': true,
    'not-yet-in-sync-exhausted': true,
    'receipt-exhausted': true
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
    const attemptOutcomes = requireAlmAttemptOutcomesField(record, path);
    return {
        handleId: requireAlmStringField(record, path, 'handleId'),
        state: requireAlmDeliveryState(record, path, 'state'),
        submitted: requireAlmBooleanField(record, path, 'submitted'),
        enqueued: requireAlmBooleanField(record, path, 'enqueued'),
        receiptMode: readAlmReceiptModeField(record, path),
        relayRejection: readAlmRelayRejectionField(record, path),
        failure: readAlmFailureField(record, path),
        carrierFallback: readAlmCarrierFallbackField(record, path),
        confirmedHopPeerIds: requireAlmStringListField(record, path, 'confirmedHopPeerIds'),
        unconfirmedHopPeerIds: requireAlmStringListField(record, path, 'unconfirmedHopPeerIds'),
        expectedRecipientPeerIds: requireAlmStringListField(
            record,
            path,
            'expectedRecipientPeerIds'
        ),
        confirmedRecipientPeerIds: requireAlmStringListField(
            record,
            path,
            'confirmedRecipientPeerIds'
        ),
        unconfirmedRecipientPeerIds: requireAlmStringListField(
            record,
            path,
            'unconfirmedRecipientPeerIds'
        ),
        attempts: requireAlmNumberField(record, path, 'attempts'),
        attemptOutcomes,
        attemptCarriers: requireAlmAttemptCarriersField(record, path, attemptOutcomes.length),
        reason: readAlmOptionalStringField(record, path, 'reason')
    };
}

export function decodeAlmStorageCountersResultValue(
    value: unknown,
    reset: boolean
): RallarBlackBoxTestStorageCountersResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'storage.counters result';
    const byOwner = requireAlmRecordField(record, path, 'byOwner');
    const work = requireAlmNumberField(byOwner, `${path}.byOwner`, 'al-work');
    const byKind = requireAlmCountsByKind(requireAlmRecordField(record, path, 'byKind'), `${path}.byKind`);
    const workProbeCount = (byKind['work-page'] ?? 0) + (byKind['work-probe'] ?? 0);
    return {
        total: requireAlmNumberField(record, path, 'total'),
        byOwner: {
            'al-admission': requireAlmNumberField(byOwner, `${path}.byOwner`, 'al-admission'),
            'al-work': work
        },
        byKind,
        workProbeCount,
        workNonProbeCount: work - workProbeCount,
        reset
    };
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

/** Absent unless a hop refused the message. */
function readAlmRelayRejectionField(
    record: RallarBlackBoxTestRecord,
    path: string
): ALDeliveryRelayRejection | undefined {
    if (record.relayRejection === undefined) {
        return undefined;
    }
    const decoded = decodeAlmRelayRejection(record.relayRejection, 'relayRejection');
    if (decoded.left !== undefined) {
        throw toAlmInvalidRuntimeResultError(`${path}.${decoded.left}`);
    }
    return decoded.right;
}

/** Absent until the send ended `rejected`, `failed` or `expired`. */
function readAlmFailureField(
    record: RallarBlackBoxTestRecord,
    path: string
): ALDeliveryFailure | undefined {
    if (record.failure === undefined) {
        return undefined;
    }
    const decoded = decodeAlmDeliveryFailure(record.failure);
    if (decoded.left !== undefined) {
        throw toAlmInvalidRuntimeResultError(`${path}.${decoded.left}`);
    }
    return decoded.right;
}

/** Absent unless the strategy handed the admitted message to its second carrier (D56). */
function readAlmCarrierFallbackField(
    record: RallarBlackBoxTestRecord,
    path: string
): ALDeliveryCarrierFallback | undefined {
    const value = record.carrierFallback;
    if (value === undefined) {
        return undefined;
    }
    const fallback = decodeAlmRuntimeRecord(value);
    const legs = RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesCarrierLeg;
    const from = legs.find((carrier) => carrier === fallback.from);
    const to = legs.find((carrier) => carrier === fallback.to);
    const { reason, atMs, detail } = fallback;
    if (
        from === undefined || to === undefined || !isAlmFallbackReason(reason) ||
        typeof atMs !== 'number' || typeof detail !== 'string'
    ) {
        throw toAlmInvalidRuntimeResultError(`${path}.carrierFallback`);
    }
    return { from, to, reason, atMs, detail };
}

function isAlmFallbackReason(value: unknown): value is ALDeliveryFallbackReason {
    return typeof value === 'string' && Object.hasOwn(ALM_FALLBACK_REASONS, value);
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

/**
 * One carrier leg per settled attempt, index-aligned with `attemptOutcomes`; the legs are the schema's own
 * `messagesCarrierLeg` list, which `requireAlmCarrierLegField` already decodes against.
 */
function requireAlmAttemptCarriersField(
    record: RallarBlackBoxTestRecord,
    path: string,
    settledAttempts: number
): readonly ALDeliveryCarrier[] {
    const values = requireAlmStringListField(record, path, 'attemptCarriers');
    const carriers = values.flatMap((value) =>
        RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesCarrierLeg.filter((carrier) => carrier === value)
    );
    if (values.length !== settledAttempts || carriers.length !== values.length) {
        throw toAlmInvalidRuntimeResultError(`${path}.attemptCarriers`);
    }
    return carriers;
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
