import { decodePersistedALMessageValue } from '../../al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey, type ALOrderingTrackSnapshot } from '../../al-contracts/al-runtime.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { decodeALAdmissionResourceEntryKey } from '../al-admission-resource-entry-validation.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import type { ALBufferedOrderedMessageSnapshot } from '../al-runtime-state-stores.ts';
import type { ALInboundDurableEffect } from './al-inbound-admission-store.ts';
import { decodeALInboundPlan } from './decode-al-inbound-plan.ts';

export interface ALInboundOrderedDeliverySnapshot extends ALBufferedOrderedMessageSnapshot {
    readonly delivery?: {
        readonly effectId: string;
        readonly inboxKey: ResourceEntry['key'] | undefined;
    };
}

export interface ALInboundBufferedSlot {
    readonly trackKey: string;
    readonly prefix: string;
    readonly key: string;
}

export function decodeALInboundOrderingSnapshot(value: unknown): ALOrderingTrackSnapshot {
    const snapshot = decodeALAdmissionRecord(value, ['lastContiguousSeq', 'bufferedSeqs', 'updatedAtMs']);
    const lastContiguousSeq = decodeALAdmissionNumber(snapshot.lastContiguousSeq);
    const updatedAtMs = decodeALAdmissionNumber(snapshot.updatedAtMs);
    const bufferedSeqs = decodeALAdmissionArray(snapshot.bufferedSeqs, decodeALAdmissionNumber);
    if (
        new Set(bufferedSeqs).size !== bufferedSeqs.length ||
        bufferedSeqs.some((sequence) => sequence <= lastContiguousSeq)
    ) {
        throw new TypeError('Persisted buffered sequences must be unique and above the contiguous sequence');
    }
    return { lastContiguousSeq, updatedAtMs, bufferedSeqs };
}

export function decodeALInboundBufferedSnapshot(
    value: unknown,
    slot: ALInboundBufferedSlot
): ALInboundOrderedDeliverySnapshot {
    const snapshot = decodeALAdmissionRecord(value, ['trackKey', 'seq', 'msg', 'plan'], ['delivery']);
    const trackKey = decodeALAdmissionString(snapshot.trackKey);
    const seq = decodeALAdmissionNumber(snapshot.seq);
    const msg = decodePersistedALMessageValue(snapshot.msg);
    const plan = decodeALInboundPlan(snapshot.plan);
    if (
        trackKey !== slot.trackKey || slot.key !== `${slot.prefix}${seq}` ||
        toALOrderingTrackKey(msg) !== trackKey || msg.ordering?.seq !== seq
    ) {
        throw new TypeError('Persisted buffered message does not match its ordering slot');
    }
    if (plan.orderingRuntime.trackKey !== undefined && plan.orderingRuntime.trackKey !== trackKey) {
        throw new TypeError('Persisted buffered plan does not match its ordering track');
    }
    if (plan.orderingRuntime.seq !== undefined && plan.orderingRuntime.seq !== seq) {
        throw new TypeError('Persisted buffered plan does not match its sequence');
    }
    if (snapshot.delivery !== undefined) {
        const delivery = decodeALAdmissionRecord(snapshot.delivery, ['effectId'], ['inboxKey']);
        decodeALAdmissionString(delivery.effectId);
        if (delivery.inboxKey !== undefined) {
            const inboxKey = decodeALAdmissionResourceEntryKey(delivery.inboxKey);
            if (
                inboxKey.topicId !== msg.route.topicId || inboxKey.resourceId !== msg.route.resourceId ||
                inboxKey.contextId !== msg.route.contextId
            ) {
                throw new TypeError('Persisted buffered inbox owner does not match its message route');
            }
        }
    }
    return value as ALInboundOrderedDeliverySnapshot;
}

/** A durable ordering fence must name the work that actually owns this buffered delivery. */
export function assertALInboundDeliveryOwner(
    effect: ALInboundDurableEffect,
    snapshot: ALInboundOrderedDeliverySnapshot
): void {
    const inboxKey = snapshot.delivery?.inboxKey;
    if (effect.kind === 'release-buffered') {
        if (effect.trackKey !== snapshot.trackKey || effect.seq !== snapshot.seq || inboxKey !== undefined) {
            throw new TypeError('Persisted release owner does not match its buffered ordering slot');
        }
        return;
    }
    if (effect.kind !== 'dispatch-local' && effect.kind !== 'enqueue-inbox') {
        throw new TypeError('Persisted ordering fence does not name a delivery effect');
    }
    if (
        effect.msg.id.msgId !== snapshot.msg.id.msgId || effect.msg.id.senderId !== snapshot.msg.id.senderId ||
        effect.msg.id.v !== snapshot.msg.id.v || effect.msg.id.ts !== snapshot.msg.id.ts ||
        toALOrderingTrackKey(effect.msg) !== snapshot.trackKey || effect.msg.ordering?.seq !== snapshot.seq
    ) {
        throw new TypeError('Persisted delivery owner does not match its buffered message');
    }
    if (effect.kind === 'enqueue-inbox') {
        if (
            !inboxKey || inboxKey.topicId !== effect.entry.key.topicId ||
            inboxKey.resourceId !== effect.entry.key.resourceId || inboxKey.contextId !== effect.entry.key.contextId
        ) {
            throw new TypeError('Persisted queued delivery owner does not match its buffered inbox key');
        }
    }
    else if (inboxKey !== undefined) {
        throw new TypeError('Persisted direct delivery owner unexpectedly has a buffered inbox key');
    }
}
