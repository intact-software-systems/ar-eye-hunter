import type {
    ALAckPayload,
    ALControlAcceptance,
    ALNackPayload,
    ALPendingAckSnapshot
} from '../../../al-contracts/al-control.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import type { ALOutsideAudienceNackReason } from '../../delivery/is-al-outside-audience-nack-reason.ts';
import type {
    ALInboundCommitBundle,
    ALInboundControlOwnerIndex,
    ALInboundMessageOwner
} from '../al-inbound-admission-store.ts';
import type { ALInboundDurableEffectWrite } from '../al-inbound-work-entry.ts';
import { acceptALPendingOutsideAudienceNack } from '../transition-al-pending-ack.ts';
import type { PendingControlValue } from './al-inbound-control-rows.ts';
import { toALInboundControlObservations } from './compute-al-inbound-control-admission.ts';
import { toALInboundUpwardControlWork } from './to-al-inbound-upward-control-work.ts';

export interface ALInboundNackAdmissionRead {
    readonly namespace: string;
    /** A child's outside-audience NACK, for itself or for a recipient below it. */
    readonly nack: ALNackPayload & Readonly<{ reason: ALOutsideAudienceNackReason; }>;
    readonly controlOwners: ALInboundControlOwnerIndex;
    readonly owner: ALInboundMessageOwner;
    readonly pending: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly nowMs: number;
    readonly controlMsgId: string;
    readonly traceId: string;
}

export interface ALInboundNackAdmissionCandidate {
    readonly read: ALInboundNackAdmissionRead;
    readonly pending: PendingControlValue | undefined;
    /** The NACK this relay re-originates toward the origin. */
    readonly upwardEffects: readonly ALInboundDurableEffectWrite[];
    readonly acceptance: ALControlAcceptance;
    readonly pendingExpireAtTimestamp: number;
}

/** A relay passes a child's outside-audience NACK upward, keeping its reason, as it passes a child's ACK (PL9). */
export function computeALInboundNackAdmission(
    read: ALInboundNackAdmissionRead,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundNackAdmissionCandidate {
    const pending = read.pending === undefined
        ? undefined
        : acceptALPendingOutsideAudienceNack(read.pending, read.nack);
    return {
        read,
        pending: pending === undefined ? undefined : { kind: 'pending', value: pending },
        upwardEffects: pending === undefined ? [] : toALInboundUpwardControlWork(
            {
                namespace: read.namespace,
                msgId: read.nack.msgId,
                owner: read.owner,
                relayPeerId: read.nack.toPeerId,
                pending,
                nowMs: read.nowMs,
                controlMsgId: read.controlMsgId,
                traceId: read.traceId
            },
            [{ kind: 'nack', logicalRecipientPeerId: read.nack.logicalRecipientPeerId, reason: read.nack.reason }],
            retention
        ),
        acceptance: { handled: true, completedPendingAcks: [] },
        pendingExpireAtTimestamp: resolveExpireAtTimestampWithFallback(
            pending?.expireAtTimestamp,
            retention.controlPendingTtlMs,
            read.nowMs
        )
    };
}

/** One conditional commit: the row that records the recipient, and the controls relayed upstream. */
export function toALInboundNackCommitBundle(candidate: ALInboundNackAdmissionCandidate): ALInboundCommitBundle {
    const { nack, owner } = candidate.read;
    return {
        admissionExpiresAtMs: null,
        senderId: owner.senderId,
        observations: toALInboundControlObservations(nack.msgId, candidate.read),
        mutations: candidate.pending === undefined ? [] : [{
            kind: 'set-control-pending',
            msgId: nack.msgId,
            senderId: owner.senderId,
            value: candidate.pending,
            expireAtTimestamp: candidate.pendingExpireAtTimestamp
        }],
        durableEffects: candidate.upwardEffects
    };
}
