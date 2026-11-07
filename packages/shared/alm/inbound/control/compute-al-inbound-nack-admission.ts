import type {
    ALAckPayload,
    ALControlAcceptance,
    ALNackPayload,
    ALPendingAckSnapshot
} from '../../../al-contracts/al-control.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import { isALOutsideAudienceNackReason } from '../../delivery/is-al-outside-audience-nack-reason.ts';
import type { ALRelayedNackReason } from '../../delivery/is-al-relayed-nack-reason.ts';
import type {
    ALInboundCommitBundle,
    ALInboundControlOwnerIndex,
    ALInboundMessageOwner
} from '../al-inbound-admission-store.ts';
import type { ALInboundDurableEffectWrite } from '../al-inbound-work-entry.ts';
import { acceptALPendingOutsideAudienceNack } from '../transition-al-pending-ack.ts';
import type { PendingControlValue } from './al-inbound-control-rows.ts';
import { toALInboundControlObservations } from './compute-al-inbound-control-admission.ts';
import {
    toALInboundUpwardControlWork,
    toALInboundUpwardNackOrdering,
    type ALInboundUpwardControl
} from './to-al-inbound-upward-control-work.ts';

export interface ALInboundNackAdmissionRead {
    readonly namespace: string;
    /** A child's relayed NACK, for itself or for a recipient below it. */
    readonly nack: ALNackPayload & Readonly<{ reason: ALRelayedNackReason; }>;
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
    /** The row with the recipient recorded outside; `undefined` for a gap NACK, which leaves the row as it was. */
    readonly pending: PendingControlValue | undefined;
    /** The NACK this relay re-originates toward the origin. */
    readonly upwardEffects: readonly ALInboundDurableEffectWrite[];
    readonly acceptance: ALControlAcceptance;
    readonly pendingExpireAtTimestamp: number;
}

/**
 * A relay passes a child's NACK upward, keeping its reason, as it passes a child's ACK (PL9). An outside-audience NACK
 * also records its recipient outside on the row; a gap NACK changes nothing here (S4ii-R3): the relay keeps no ordering
 * record, and the origin's repair reaches the recipient through the relay's forward.
 */
export function computeALInboundNackAdmission(
    read: ALInboundNackAdmissionRead,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundNackAdmissionCandidate {
    const pending = read.pending !== undefined && isALOutsideAudienceNackReason(read.nack.reason)
        ? acceptALPendingOutsideAudienceNack(read.pending, read.nack)
        : undefined;
    const row = pending ?? read.pending;
    const upwardNack = toUpwardNack(read.nack);
    return {
        read,
        pending: pending === undefined ? undefined : { kind: 'pending', value: pending },
        upwardEffects: row === undefined || upwardNack === undefined ? [] : toALInboundUpwardControlWork(
            {
                namespace: read.namespace,
                msgId: read.nack.msgId,
                owner: read.owner,
                relayPeerId: read.nack.toPeerId,
                pending: row,
                nowMs: read.nowMs,
                controlMsgId: read.controlMsgId,
                traceId: read.traceId
            },
            [upwardNack],
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

function toUpwardNack(nack: ALInboundNackAdmissionRead['nack']): ALInboundUpwardControl | undefined {
    const { logicalRecipientPeerId, reason } = nack;
    if (reason !== 'gap') {
        return { kind: 'nack', logicalRecipientPeerId, reason };
    }
    const ordering = toALInboundUpwardNackOrdering(nack);
    return ordering === undefined ? undefined : { kind: 'nack', logicalRecipientPeerId, reason, ordering };
}

/** One conditional commit: the row that records the recipient, if any, and the controls relayed upstream. */
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
