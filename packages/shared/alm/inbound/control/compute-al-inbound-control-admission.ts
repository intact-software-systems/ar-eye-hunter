import type {
    ALAckPayload,
    ALCompletedPendingAck,
    ALControlAcceptance,
    ALPendingAckSnapshot
} from '../../../al-contracts/al-control.ts';
import { newALAckControlMessage } from '../../../al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback, toExpireAtTimestampFromNow } from '../../ALStoreRetention.ts';
import type {
    ALInboundAdmissionObservations,
    ALInboundCommitBundle,
    ALInboundControlOwnerIndex,
    ALInboundMessageOwner
} from '../al-inbound-admission-store.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import { computeALInboundWorkEntry, type ALInboundDurableEffectWrite } from '../al-inbound-work-entry.ts';
import { acceptALPendingAckPayload } from '../transition-al-pending-ack.ts';
import type { AcksControlValue, PendingControlValue } from './al-inbound-control-rows.ts';

export interface ALInboundControlAdmissionRead {
    readonly namespace: string;
    /** The acknowledgement as this store received it, stamped with the carrier it arrived on. */
    readonly ack: ALAckPayload;
    readonly controlOwners: ALInboundControlOwnerIndex;
    readonly owner: ALInboundMessageOwner;
    readonly pending: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly nowMs: number;
    readonly controlMsgId: string;
}

export interface ALInboundControlAdmissionCandidate {
    readonly read: ALInboundControlAdmissionRead;
    readonly acks: AcksControlValue;
    readonly pending: PendingControlValue | undefined;
    readonly completedEffects: readonly ALInboundDurableEffectWrite[];
    readonly acceptance: ALControlAcceptance;
    readonly controlExpireAtTimestamp: number;
    readonly pendingExpireAtTimestamp: number;
}

export function computeALInboundControlAdmission(
    read: ALInboundControlAdmissionRead,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundControlAdmissionCandidate {
    const retainedAcks = read.acks.slice(-(AL_MESSAGE_RESOURCE_LIMITS.collectionEntries - 1));
    const acks = [...retainedAcks, read.ack];
    const transition = acceptALPendingAckPayload({
        current: read.pending,
        nextAcks: acks,
        ack: read.ack
    });
    const completed = transition.completed;
    return {
        read,
        acks: { kind: 'acks', values: acks },
        pending: transition.pending === undefined ? undefined : { kind: 'pending', value: transition.pending },
        completedEffects: completed
            ? computeCompletedAcknowledgementWork(read, { completed, acks: transition.completedAcks }, retention)
            : [],
        acceptance: {
            handled: true,
            completedPendingAcks: completed ? [completed] : []
        },
        controlExpireAtTimestamp: toExpireAtTimestampFromNow(retention.controlHistoryTtlMs, read.nowMs),
        pendingExpireAtTimestamp: resolveExpireAtTimestampWithFallback(
            transition.pending?.expireAtTimestamp,
            retention.controlPendingTtlMs,
            read.nowMs
        )
    };
}

/** One conditional commit: the acknowledgement history, its pending receipt, and the forwarded ACK. */
export function toALInboundControlCommitBundle(
    candidate: ALInboundControlAdmissionCandidate
): ALInboundCommitBundle {
    const { ack, owner } = candidate.read;
    return {
        admissionExpiresAtMs: null,
        senderId: owner.senderId,
        observations: toALInboundControlObservations(candidate.read),
        mutations: [
            {
                kind: 'set-control-acks',
                msgId: ack.ackedMsgId,
                senderId: owner.senderId,
                value: candidate.acks,
                expireAtTimestamp: candidate.controlExpireAtTimestamp
            },
            candidate.pending === undefined
                ? { kind: 'delete-control-pending', msgId: ack.ackedMsgId, senderId: owner.senderId }
                : {
                    kind: 'set-control-pending',
                    msgId: ack.ackedMsgId,
                    senderId: owner.senderId,
                    value: candidate.pending,
                    expireAtTimestamp: candidate.pendingExpireAtTimestamp
                }
        ],
        durableEffects: candidate.completedEffects
    };
}

function toALInboundControlObservations(
    read: ALInboundControlAdmissionRead
): ALInboundAdmissionObservations {
    return {
        msgId: read.ack.ackedMsgId,
        senderId: read.owner.senderId,
        messageOwner: read.owner,
        dedup: undefined,
        ordering: undefined,
        buffered: undefined,
        deliveryProgress: undefined,
        supersedence: {},
        pendingAck: read.pending,
        acks: read.acks,
        controlOwners: read.controlOwners
    };
}

interface ALInboundCompletedReceipt {
    readonly completed: ALCompletedPendingAck;
    /** One admitted ACK per logical recipient; never empty, since the ACK that completed it is among them. */
    readonly acks: readonly ALAckPayload[];
}

/** The relay re-originates one ACK per logical recipient its subtree confirmed (D40), copying who each speaks for. */
function computeCompletedAcknowledgementWork(
    read: ALInboundControlAdmissionRead,
    receipt: ALInboundCompletedReceipt,
    retention: NormalizedALRuntimeStoreRetentionConfig
): readonly ALInboundDurableEffectWrite[] {
    const { completed } = receipt;
    // The completed ACK travels back toward the message's sender, over the carrier that message arrived on.
    const carrier = toALDeliveryCarrier(read.owner.source);
    const relayPeerId = read.ack.toPeerId;
    return receipt.acks.map((recipient, index) => {
        const controlMsgId = `${read.controlMsgId}:${index}`;
        return computeALInboundWorkEntry({
            namespace: read.namespace,
            observedAtMs: read.nowMs,
            effectId: toInboundEffectId('ack', completed.msgId, completed.toPeerId, completed.status, controlMsgId),
            expireAtTimestamp: resolveExpireAtTimestampWithFallback(
                completed.expireAtTimestamp,
                retention.durableEffectTtlMs,
                read.nowMs
            ),
            carrier,
            payload: {
                kind: 'send-control',
                msg: newALAckControlMessage(
                    { v: 2, msgId: controlMsgId, senderId: relayPeerId, ts: read.nowMs },
                    {
                        fromPeerId: relayPeerId,
                        toPeerId: completed.toPeerId,
                        ackedMsgId: completed.msgId,
                        originPeerId: recipient.originPeerId,
                        logicalRecipientPeerId: recipient.logicalRecipientPeerId,
                        carrier,
                        status: completed.status,
                        observedAtEpochMs: read.nowMs
                    }
                )
            }
        });
    });
}

function toInboundEffectId(...parts: readonly (number | string)[]): string {
    return parts.map((part) => encodeURIComponent(String(part))).join(':');
}
