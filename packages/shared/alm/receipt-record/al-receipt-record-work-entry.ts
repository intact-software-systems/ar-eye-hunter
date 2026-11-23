import { fnv1a64, toAppQueueKey } from '../../queuebox/AppQueueIdentity.ts';
import { isKeysEqual, type Key, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import { decodeALAdmissionRecord, decodeALAdmissionString } from '../al-admission-value-validation.ts';
import { computeALWorkEntry } from '../work/compute-al-work-entry.ts';

import type { ALReceiptRecordRef } from './al-receipt-record-keys.ts';

export type ALReceiptRecordWorkKind = 'deadline' | 'ended';

export interface ALReceiptRecordWork {
    readonly kind: ALReceiptRecordWorkKind;
    readonly ref: ALReceiptRecordRef;
}

export interface ALReceiptRecordWorkEntryInput {
    readonly namespace: string;
    readonly work: ALReceiptRecordWork;
    readonly observedAtMs: number;
    readonly readyAtMs: number;
    readonly expireAtTimestamp: number;
}

const WORK_TOPICS: Readonly<Record<ALReceiptRecordWorkKind, string>> = {
    deadline: 'AL_RECEIPT_DEADLINE',
    ended: 'AL_RECEIPT_ENDED'
};

export function toALReceiptRecordWorkType(namespace: string): string {
    return `AL_RECEIPT_RECORD:${fnv1a64(namespace)}`;
}

export function toALReceiptRecordWorkKey(
    namespace: string,
    kind: ALReceiptRecordWorkKind,
    ref: ALReceiptRecordRef
): Key {
    return toAppQueueKey({
        topicId: WORK_TOPICS[kind],
        resourceId: encodeURIComponent(namespace),
        contextId: encodeURIComponent(JSON.stringify([ref.originPeerId, ref.msgId]))
    });
}

export function computeALReceiptRecordWorkEntry(input: ALReceiptRecordWorkEntryInput): ResourceEntry {
    const { namespace, work } = input;
    return computeALWorkEntry({
        key: toALReceiptRecordWorkKey(namespace, work.kind, work.ref),
        typeId: toALReceiptRecordWorkType(namespace),
        resource: JSON.stringify({
            namespace,
            kind: work.kind,
            originPeerId: work.ref.originPeerId,
            msgId: work.ref.msgId
        }),
        observedAtMs: input.observedAtMs,
        readyAtMs: input.readyAtMs,
        expireAtTimestamp: input.expireAtTimestamp
    });
}

export function decodeALReceiptRecordWorkEntry(entry: ResourceEntry, namespace: string): ALReceiptRecordWork {
    try {
        const stored = decodeALAdmissionRecord(JSON.parse(entry.resource), [
            'namespace',
            'kind',
            'originPeerId',
            'msgId'
        ]);
        if (stored.namespace !== namespace) {
            throw new TypeError('Receipt record work identity differs from its record scope');
        }
        const kind = decodeALAdmissionString(stored.kind);
        if (!isALReceiptRecordWorkKind(kind)) {
            throw new TypeError(`Receipt record work kind '${kind}' is unknown`);
        }
        const ref = {
            originPeerId: decodeALAdmissionString(stored.originPeerId),
            msgId: decodeALAdmissionString(stored.msgId)
        };
        if (
            entry.typeId !== toALReceiptRecordWorkType(namespace) ||
            !isKeysEqual(entry.key, toALReceiptRecordWorkKey(namespace, kind, ref))
        ) {
            throw new TypeError('Receipt record work identity differs from its queue slot');
        }
        return { kind, ref };
    }
    catch (error) {
        throw new ALAdmissionCorruptionError(JSON.stringify(entry.key), toError(error));
    }
}

function isALReceiptRecordWorkKind(kind: string): kind is ALReceiptRecordWorkKind {
    return Object.hasOwn(WORK_TOPICS, kind);
}
