import { decodeALReceiptIdentifier } from '../../al-contracts/al-control-value-codec.ts';
import { decodeALTraceId } from '../../al-contracts/trace/al-trace-id.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord
} from '../al-admission-value-validation.ts';

import { toALReceiptRecordHeadKey, type ALReceiptRecordRef } from './al-receipt-record-keys.ts';

export interface ALReceiptRecordOpening extends ALReceiptRecordRef {
    readonly traceId: string;
    readonly expectedRecipientPeerIds: readonly string[];
    /** Expected recipients the record's owner never sent the message: only the owner's `not-sent` counts for them. */
    readonly neverSentRecipientPeerIds: readonly string[];
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
        confirmedRecipientPeerIds: decodeALAdmissionArray(head.confirmedRecipientPeerIds, decodeRecipientPeerId),
        outsideAudienceRecipientPeerIds: decodeALAdmissionArray(
            head.outsideAudienceRecipientPeerIds,
            decodeRecipientPeerId
        ),
        endedAtEpochMs: decodeALAdmissionNumber(head.endedAtEpochMs)
    };
}

export function decodeALReceiptRecordConfirmation(value: unknown, key: string): ALReceiptRecordConfirmation {
    const confirmation = decodeALAdmissionRecord(value, ['recipientPeerId', 'kind', 'countedAtEpochMs']);
    const recipientPeerId = decodeRecipientPeerId(confirmation.recipientPeerId);
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
        neverSentRecipientPeerIds: [...opening.neverSentRecipientPeerIds],
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
        'neverSentRecipientPeerIds',
        'snapshotVersion',
        'deadlineAtMs'
    ]);
    const ref = {
        originPeerId: decodeALReceiptIdentifier(opening.originPeerId, 'Stored receipt origin', 'peer-id'),
        msgId: decodeALReceiptIdentifier(opening.msgId, 'Stored receipt message id', 'message-id')
    };
    if (!key.endsWith(toALReceiptRecordHeadKey('', ref))) {
        throw new TypeError('Stored receipt head belongs to another message');
    }
    return {
        ...ref,
        traceId: decodeStoredTraceId(opening.traceId),
        expectedRecipientPeerIds: decodeALAdmissionArray(opening.expectedRecipientPeerIds, decodeRecipientPeerId),
        neverSentRecipientPeerIds: decodeALAdmissionArray(opening.neverSentRecipientPeerIds, decodeRecipientPeerId),
        snapshotVersion: decodeALAdmissionNumber(opening.snapshotVersion),
        deadlineAtMs: decodeALAdmissionNumber(opening.deadlineAtMs)
    };
}

/** A receipt control names every identity of its head, so a stored row holds only identities the control accepts. */
function decodeRecipientPeerId(value: unknown): string {
    return decodeALReceiptIdentifier(value, 'Stored receipt recipient', 'peer-id');
}

/** The receipt control carries the opening's trace as its own trace. */
function decodeStoredTraceId(value: unknown): string {
    return decodeALTraceId(value).fold(
        (issue) => {
            throw new TypeError(`Stored receipt trace is invalid: ${issue.message}`);
        },
        (traceId) => traceId
    );
}
