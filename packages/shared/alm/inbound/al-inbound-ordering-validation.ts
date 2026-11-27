import type { ALDeliveryCarrier } from '../../al-contracts/al-control-value-codec.ts';
import { decodeALMessageValue, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey, type ALOrderingTrackSnapshot } from '../../al-contracts/al-runtime.ts';
import { computeUtf8ByteLength } from '../../encoding/compute-utf8-byte-length.ts';
import type { ALAdmissionBackend } from '../al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionCarrier,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import type { ALBufferedOrderedMessageSnapshot } from '../al-runtime-state-stores.ts';
import { isALInboundDeliveryReaching } from './admission/al-inbound-delivery-progress.ts';
import type {
    ALInboundCommitBundle,
    ALInboundDeliveryProgress,
    ALInboundDurableEffect
} from './al-inbound-admission-store.ts';
import {
    decodeALInboundMessageReference,
    readALInboundStoredMessage,
    toALInboundMessageKey,
    toALInboundMessageReference,
    type ALInboundMessageReference
} from './al-inbound-canonical-message.ts';
import { decodeALInboundPlan } from './decode-al-inbound-plan.ts';

export interface ALInboundDeliveryOwner {
    readonly effectId: string;
}

/** A carrier that brought a copy of a buffered message, and the peer that copy acknowledges to; null for none. */
export interface ALInboundBufferedCopyCarrier {
    readonly carrier: ALDeliveryCarrier;
    readonly ackToPeerId: string | null;
}

export interface ALInboundOrderedDeliverySnapshot extends ALBufferedOrderedMessageSnapshot {
    /** The carrier the buffered message arrived on: its release is claimed and dispatched by that runtime. */
    readonly carrier: ALDeliveryCarrier;
    /**
     * Every carrier and acknowledging peer that brought a copy while the slot stood, each pair once, the slot's own pair
     * (on `carrier`) first: a sender may hold its receipt on any carrier, and a reshape may hand the slot a second parent on the same
     * one, so the release answers each.
     */
    readonly copyCarriers: readonly ALInboundBufferedCopyCarrier[];
    /**
     * The sequence the copy's completed delivery moves the track's progress through: `seq`, or past the expired copies a
     * bounded hold passed after the run this copy ends.
     */
    readonly completesThrough: number;
    readonly delivery?: ALInboundDeliveryOwner;
}

/** A stored slot read back through the owner row it names, which also fixes how long the slot may live. */
export interface ALInboundResolvedDeliverySnapshot extends ALInboundOrderedDeliverySnapshot {
    readonly ownerRetainUntilMs: number;
}

/** The persisted ordering slot names its message instead of copying it; the owner row holds the payload. */
export interface ALStoredInboundBufferedSnapshot {
    readonly trackKey: string;
    readonly seq: number;
    readonly message: ALInboundMessageReference;
    readonly plan: ALMessageHandlingPlan;
    readonly carrier: ALDeliveryCarrier;
    readonly copyCarriers: readonly ALInboundBufferedCopyCarrier[];
    readonly completesThrough: number;
    readonly delivery?: ALInboundDeliveryOwner;
}

/** The record fields of a stored buffered slot, which every reader of the row decodes. */
export const AL_INBOUND_BUFFERED_SLOT_FIELDS = [
    'trackKey',
    'seq',
    'message',
    'plan',
    'carrier',
    'copyCarriers',
    'completesThrough'
] as const;

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

export function toALStoredInboundBufferedSnapshot(
    snapshot: ALInboundOrderedDeliverySnapshot
): ALStoredInboundBufferedSnapshot {
    return {
        trackKey: snapshot.trackKey,
        seq: snapshot.seq,
        message: toALInboundMessageReference(snapshot.msg),
        plan: snapshot.plan,
        carrier: snapshot.carrier,
        copyCarriers: snapshot.copyCarriers,
        completesThrough: snapshot.completesThrough,
        ...(snapshot.delivery === undefined ? {} : { delivery: snapshot.delivery })
    };
}

export function decodeALInboundBufferedSnapshot(
    value: unknown,
    slot: ALInboundBufferedSlot
): ALStoredInboundBufferedSnapshot {
    const snapshot = decodeALAdmissionRecord(value, AL_INBOUND_BUFFERED_SLOT_FIELDS, ['delivery']);
    const trackKey = decodeALAdmissionString(snapshot.trackKey);
    const seq = decodeALAdmissionNumber(snapshot.seq);
    const message = decodeALInboundMessageReference(snapshot.message);
    const plan = decodeALInboundPlan(snapshot.plan);
    const carrier = decodeALAdmissionCarrier(snapshot.carrier);
    const copyCarriers = decodeALAdmissionArray(snapshot.copyCarriers, decodeBufferedCopyCarrier);
    if (
        copyCarriers[0]?.carrier !== carrier ||
        new Set(copyCarriers.map(toBufferedCopyKey)).size !== copyCarriers.length
    ) {
        throw new TypeError('Persisted buffered copy carriers must name the slot carrier first, each pair once');
    }
    const completesThrough = decodeALAdmissionNumber(snapshot.completesThrough);
    if (
        trackKey !== slot.trackKey || slot.key !== `${slot.prefix}${seq}` ||
        !isALInboundDeliveryReaching({ seq, completesThrough }, seq)
    ) {
        throw new TypeError('Persisted buffered message does not match its ordering slot');
    }
    if (plan.orderingRuntime.trackKey !== undefined && plan.orderingRuntime.trackKey !== trackKey) {
        throw new TypeError('Persisted buffered plan does not match its ordering track');
    }
    if (plan.orderingRuntime.seq !== undefined && plan.orderingRuntime.seq !== seq) {
        throw new TypeError('Persisted buffered plan does not match its sequence');
    }
    if (snapshot.delivery === undefined) {
        return { trackKey, seq, message, plan, carrier, copyCarriers, completesThrough };
    }
    const delivery = decodeALAdmissionRecord(snapshot.delivery, ['effectId']);
    return {
        trackKey,
        seq,
        message,
        plan,
        carrier,
        copyCarriers,
        completesThrough,
        delivery: { effectId: decodeALAdmissionString(delivery.effectId) }
    };
}

function toBufferedCopyKey(copy: ALInboundBufferedCopyCarrier): string {
    return JSON.stringify([copy.carrier, copy.ackToPeerId]);
}

function decodeBufferedCopyCarrier(value: unknown): ALInboundBufferedCopyCarrier {
    const copy = decodeALAdmissionRecord(value, ['carrier', 'ackToPeerId']);
    return {
        carrier: decodeALAdmissionCarrier(copy.carrier),
        ackToPeerId: copy.ackToPeerId === null ? null : decodeALAdmissionString(copy.ackToPeerId)
    };
}

export interface ReadALInboundBufferedMessageInput {
    readonly database: Pick<ALAdmissionBackend, 'read'>;
    readonly namespace: string;
    /** The slot `stored` was read from. */
    readonly slot: ALInboundBufferedSlot;
    readonly stored: ALStoredInboundBufferedSnapshot;
}

/**
 * The buffered slot only names its message, so every ordering decision resolves the owner row first. A slot and its
 * message row expire together, and no backend holds one snapshot or one clock reading across a read chain, so a chain
 * may read the slot before that instant and the row after it, or after a writer that met both expired deleted them.
 * The slot's own key, read again, decides: gone, the pair left together and the chain read no slot (`undefined`);
 * still stored, the slot lost its row, which no write leaves, and that is corruption.
 */
export async function readALInboundBufferedMessage(
    input: ReadALInboundBufferedMessageInput
): Promise<ALInboundResolvedDeliverySnapshot | undefined> {
    const { database, namespace, slot, stored } = input;
    const owner = await readALInboundStoredMessage({ database, namespace, reference: stored.message });
    if (owner === undefined && !await readALInboundBufferedSlotStored(database, slot)) {
        return undefined;
    }
    if (
        owner === undefined || toALOrderingTrackKey(owner.msg) !== stored.trackKey ||
        owner.msg.ordering?.seq !== stored.seq
    ) {
        throw new ALAdmissionCorruptionError(
            toALInboundMessageKey(namespace, stored.message),
            new TypeError('Buffered inbound ordering slot lost its canonical message')
        );
    }
    return {
        trackKey: stored.trackKey,
        seq: stored.seq,
        msg: owner.msg,
        plan: stored.plan,
        carrier: stored.carrier,
        copyCarriers: stored.copyCarriers,
        completesThrough: stored.completesThrough,
        ownerRetainUntilMs: owner.retainUntilMs,
        ...(stored.delivery === undefined ? {} : { delivery: stored.delivery })
    };
}

async function readALInboundBufferedSlotStored(
    database: Pick<ALAdmissionBackend, 'read'>,
    slot: ALInboundBufferedSlot
): Promise<boolean> {
    return await database.read(slot.key, (value) => decodeALInboundBufferedSnapshot(value, slot)) !== undefined;
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
    let bytes = 0;
    for (const msg of buffered.values()) {
        bytes += computeUtf8ByteLength(JSON.stringify(msg));
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
    if (
        effect.message.msgId !== snapshot.msg.id.msgId || effect.message.senderId !== snapshot.msg.id.senderId
    ) {
        throw new TypeError('Persisted delivery owner does not match its buffered message');
    }
}
