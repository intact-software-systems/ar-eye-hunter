import {
    decodeALMessageValue,
    decodePersistedALMessage,
    decodePersistedALMessageValue,
    type ALMessageRejection
} from '../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey, type ALOrderingTrackSnapshot } from '../../al-contracts/al-runtime.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import type { ALBufferedOrderedMessageSnapshot } from '../al-runtime-state-stores.ts';
import type {
    ALInboundCommitBundle,
    ALInboundDeliveryProgress,
    ALInboundDurableEffect
} from './al-inbound-admission-store.ts';
import { decodeALInboundPlan } from './decode-al-inbound-plan.ts';

export interface ALInboundOrderedDeliverySnapshot extends ALBufferedOrderedMessageSnapshot {
    readonly delivery?: {
        readonly effectId: string;
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

export function decodeALInboundDeliveryProgress(value: unknown): ALInboundDeliveryProgress {
    const progress = decodeALAdmissionRecord(value, ['completedThrough', 'expireAtTimestamp']);
    return {
        completedThrough: decodeALAdmissionNumber(progress.completedThrough),
        expireAtTimestamp: decodeALAdmissionNumber(progress.expireAtTimestamp)
    };
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
        const delivery = decodeALAdmissionRecord(snapshot.delivery, ['effectId']);
        decodeALAdmissionString(delivery.effectId);
    }
    return value as ALInboundOrderedDeliverySnapshot;
}

export function validateALInboundBufferedMessages(bundle: ALInboundCommitBundle): readonly ALMessageRejection[] {
    const mutations = bundle.mutations.filter((mutation) =>
        mutation.kind === 'set-buffered' || mutation.kind === 'delete-buffered'
    );
    if (mutations.length === 0) {
        return [];
    }
    const observed = bundle.observations.ordering?.buffered ??
        (bundle.observations.buffered === undefined ? [] : [bundle.observations.buffered]);
    const buffered = new Map(observed.map((snapshot) => [snapshot.seq, snapshot.msg]));
    const issues: ALMessageRejection[] = [];
    for (const mutation of mutations) {
        if (mutation.kind === 'delete-buffered') {
            buffered.delete(mutation.seq);
            continue;
        }
        const decoded = decodeALMessageValue(mutation.snapshot.msg);
        if (decoded.left) {
            issues.push(decoded.left);
        }
        buffered.set(mutation.snapshot.seq, mutation.snapshot.msg);
    }
    if (issues.length > 0) {
        return issues;
    }
    const encoder = new TextEncoder();
    let bytes = 0;
    for (const msg of buffered.values()) {
        bytes += encoder.encode(JSON.stringify(msg)).length;
    }
    if (
        buffered.size > AL_MESSAGE_RESOURCE_LIMITS.bufferedMessages || bytes > AL_MESSAGE_RESOURCE_LIMITS.bufferedBytes
    ) {
        issues.push({ code: 'oversized', message: 'Inbound admission candidate exceeds the ordered buffer budget' });
    }
    return issues;
}

/** A durable ordering fence must name the work that actually owns this buffered delivery. */
export function assertALInboundDeliveryOwner(
    effect: ALInboundDurableEffect,
    snapshot: ALInboundOrderedDeliverySnapshot
): void {
    if (effect.kind === 'release-buffered') {
        if (effect.trackKey !== snapshot.trackKey || effect.seq !== snapshot.seq) {
            throw new TypeError('Persisted release owner does not match its buffered ordering slot');
        }
        return;
    }
    if (effect.kind !== 'dispatch-local') {
        throw new TypeError('Persisted ordering fence does not name a delivery effect');
    }
    const effectMessage = decodePersistedALMessage(effect.entry.resource);
    if (
        effectMessage.id.msgId !== snapshot.msg.id.msgId || effectMessage.id.senderId !== snapshot.msg.id.senderId ||
        effectMessage.id.v !== snapshot.msg.id.v || effectMessage.id.ts !== snapshot.msg.id.ts ||
        toALOrderingTrackKey(effectMessage) !== snapshot.trackKey || effectMessage.ordering?.seq !== snapshot.seq
    ) {
        throw new TypeError('Persisted delivery owner does not match its buffered message');
    }
}
