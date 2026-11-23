import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';

import { toALReceiptRecordHeadKey, type ALReceiptRecordRef } from './al-receipt-record-keys.ts';

export interface ALReceiptRecordOpening extends ALReceiptRecordRef {
    readonly traceId: string;
    readonly expectedRecipientPeerIds: readonly string[];
    readonly snapshotVersion: number;
    readonly deadlineAtMs: number;
}

export interface ALReceiptRecordOpenHead {
    readonly phase: 'open';
    readonly opening: ALReceiptRecordOpening;
}

export interface ALReceiptRecordEndedHead {
    readonly phase: 'complete' | 'timed-out';
    readonly opening: ALReceiptRecordOpening;
    readonly confirmedRecipientPeerIds: readonly string[];
    readonly outsideAudienceRecipientPeerIds: readonly string[];
    readonly endedAtEpochMs: number;
}

export type ALReceiptRecordHead = ALReceiptRecordOpenHead | ALReceiptRecordEndedHead;

export interface ALReceiptRecordConfirmation {
    readonly recipientPeerId: string;
    readonly kind: 'confirmed' | 'outside';
    readonly countedAtEpochMs: number;
}

const OPEN_HEAD_FIELDS = ['phase', 'opening'];
const ENDED_HEAD_FIELDS = [
    ...OPEN_HEAD_FIELDS,
    'confirmedRecipientPeerIds',
    'outsideAudienceRecipientPeerIds',
    'endedAtEpochMs'
];
const HEAD_FIELDS_BESIDE_PHASE = ENDED_HEAD_FIELDS.filter((field) => field !== 'phase');

export function decodeALReceiptRecordHead(value: unknown, key: string): ALReceiptRecordHead {
    const { phase } = decodeALAdmissionRecord(value, ['phase'], HEAD_FIELDS_BESIDE_PHASE);
    if (phase === 'open') {
        const head = decodeALAdmissionRecord(value, OPEN_HEAD_FIELDS);
        return { phase, opening: decodeALReceiptRecordOpening(head.opening, key) };
    }
    if (phase !== 'complete' && phase !== 'timed-out') {
        throw new TypeError('Stored receipt head phase is invalid');
    }
    const head = decodeALAdmissionRecord(value, ENDED_HEAD_FIELDS);
    return {
        phase,
        opening: decodeALReceiptRecordOpening(head.opening, key),
        confirmedRecipientPeerIds: decodeALAdmissionArray(head.confirmedRecipientPeerIds, decodeALAdmissionString),
        outsideAudienceRecipientPeerIds: decodeALAdmissionArray(
            head.outsideAudienceRecipientPeerIds,
            decodeALAdmissionString
        ),
        endedAtEpochMs: decodeALAdmissionNumber(head.endedAtEpochMs)
    };
}

export function decodeALReceiptRecordConfirmation(value: unknown, key: string): ALReceiptRecordConfirmation {
    const confirmation = decodeALAdmissionRecord(value, ['recipientPeerId', 'kind', 'countedAtEpochMs']);
    const recipientPeerId = decodeALAdmissionString(confirmation.recipientPeerId);
    if (!key.endsWith(`:${recipientPeerId}`)) {
        throw new TypeError('Stored receipt confirmation belongs to another recipient');
    }
    const { kind } = confirmation;
    if (kind !== 'confirmed' && kind !== 'outside') {
        throw new TypeError('Stored receipt confirmation kind is invalid');
    }
    return { recipientPeerId, kind, countedAtEpochMs: decodeALAdmissionNumber(confirmation.countedAtEpochMs) };
}

/** The opening as stored: its named fields only, never the caller's object or array. */
export function toALReceiptRecordStoredOpening(opening: ALReceiptRecordOpening): ALReceiptRecordOpening {
    return {
        originPeerId: opening.originPeerId,
        msgId: opening.msgId,
        traceId: opening.traceId,
        expectedRecipientPeerIds: [...opening.expectedRecipientPeerIds],
        snapshotVersion: opening.snapshotVersion,
        deadlineAtMs: opening.deadlineAtMs
    };
}

export function decodeALReceiptRecordOpening(value: unknown, key: string): ALReceiptRecordOpening {
    const opening = decodeALAdmissionRecord(value, [
        'originPeerId',
        'msgId',
        'traceId',
        'expectedRecipientPeerIds',
        'snapshotVersion',
        'deadlineAtMs'
    ]);
    const ref = {
        originPeerId: decodeALAdmissionString(opening.originPeerId),
        msgId: decodeALAdmissionString(opening.msgId)
    };
    if (!key.endsWith(toALReceiptRecordHeadKey('', ref))) {
        throw new TypeError('Stored receipt head belongs to another message');
    }
    return {
        ...ref,
        traceId: decodeALAdmissionString(opening.traceId),
        expectedRecipientPeerIds: decodeALAdmissionArray(opening.expectedRecipientPeerIds, decodeALAdmissionString),
        snapshotVersion: decodeALAdmissionNumber(opening.snapshotVersion),
        deadlineAtMs: decodeALAdmissionNumber(opening.deadlineAtMs)
    };
}
