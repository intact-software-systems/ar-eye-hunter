import type {
    ALAckPayload,
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
import { toALInboundUpwardAcks } from '../al-inbound-effect-intent.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import { computeALInboundWorkEntry, type ALInboundDurableEffectWrite } from '../al-inbound-work-entry.ts';
import { acceptALPendingAckPayload, type ALPendingAckTransition } from '../transition-al-pending-ack.ts';
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
    /** The ACKs this admission sends toward the origin: the one it relays, then the terminal one if it completed. */
    readonly upwardEffects: readonly ALInboundDurableEffectWrite[];
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
    const transition = acceptALPendingAckPayload({ current: read.pending, ack: read.ack });
    const completed = transition.completed;
    return {
        read,
        acks: { kind: 'acks', values: acks },
        pending: transition.pending === undefined ? undefined : { kind: 'pending', value: transition.pending },
        upwardEffects: computeUpwardAcknowledgementWork(read, transition, retention),
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

/** One conditional commit: the acknowledgement history, its pending row, and the ACKs relayed upstream. */
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
            // A candidate without a row never validates: an acknowledgement is admitted only against its row.
            ...(candidate.pending === undefined ? [] : [{
                kind: 'set-control-pending' as const,
                msgId: ack.ackedMsgId,
                senderId: owner.senderId,
                value: candidate.pending,
                expireAtTimestamp: candidate.pendingExpireAtTimestamp
            }])
        ],
        durableEffects: candidate.upwardEffects
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

/**
 * The relay sends one ACK per recipient a child ACK named, then its own terminal ACK once its row
 * completed (D40). The origin is its own message-owner row sender, never what a child ACK claimed.
 */
function computeUpwardAcknowledgementWork(
    read: ALInboundControlAdmissionRead,
    transition: ALPendingAckTransition,
    retention: NormalizedALRuntimeStoreRetentionConfig
): readonly ALInboundDurableEffectWrite[] {
    const pending = transition.pending;
    if (pending === undefined) {
        return [];
    }
    // The ACKs travel back toward the message sender, over the carrier that message arrived on.
    const carrier = toALDeliveryCarrier(read.owner.source);
    const relayPeerId = read.ack.toPeerId;
    return toALInboundUpwardAcks(transition).map((upward, index) => {
        const controlMsgId = `${read.controlMsgId}:${index}`;
        return computeALInboundWorkEntry({
            namespace: read.namespace,
            observedAtMs: read.nowMs,
            effectId: toInboundEffectId('ack', read.ack.ackedMsgId, pending.toPeerId, upward.status, controlMsgId),
            expireAtTimestamp: resolveExpireAtTimestampWithFallback(
                pending.expireAtTimestamp,
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
                        toPeerId: pending.toPeerId,
                        ackedMsgId: read.ack.ackedMsgId,
                        originPeerId: read.owner.senderId,
                        logicalRecipientPeerId: upward.logicalRecipient.kind === 'self'
                            ? relayPeerId
                            : upward.logicalRecipient.peerId,
                        carrier,
                        status: upward.status,
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
