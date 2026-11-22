import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALControlAcceptance,
    ALNackPayload,
    ALPendingAckSnapshot
} from '../../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback, toExpireAtTimestampFromNow } from '../../ALStoreRetention.ts';
import { isALOutsideAudienceNackReason } from '../../delivery/is-al-outside-audience-nack-reason.ts';
import type { ALRelayedNackReason } from '../../delivery/is-al-relayed-nack-reason.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundCommitBundle,
    ALInboundControlOwnerIndex,
    ALInboundMessageOwner
} from '../al-inbound-admission-store.ts';
import type { ALInboundDurableEffectWrite } from '../al-inbound-work-entry.ts';
import { acceptALPendingOutsideAudienceNack } from '../transition-al-pending-ack.ts';
import type { NacksControlValue, PendingControlValue } from './al-inbound-control-rows.ts';
import { toALInboundControlObservations } from './compute-al-inbound-control-admission.ts';
import { toALInboundUpwardControlWork } from './to-al-inbound-upward-control-work.ts';

export interface ALInboundNackAdmissionRead {
    readonly namespace: string;
    /** A child's relayed NACK, for itself or for a recipient below it. */
    readonly nack: ALNackPayload & Readonly<{ reason: ALRelayedNackReason; }>;
    /** Absent for a message no child acknowledges, which keeps no control-owner index. */
    readonly controlOwners: ALInboundControlOwnerIndex | undefined;
    readonly owner: ALInboundMessageOwner;
    readonly pending: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly nacks: readonly ALNackPayload[];
    readonly nowMs: number;
    readonly controlMsgId: string;
    readonly traceId: string;
}

export interface ALInboundNackAdmissionCandidate {
    readonly read: ALInboundNackAdmissionRead;
    /** The row with the recipient recorded outside; `undefined` for a gap NACK, which leaves the row as it was. */
    readonly pending: PendingControlValue | undefined;
    /** The NACK history with this outside-audience NACK appended; `undefined` for a gap NACK, which writes no row. */
    readonly nacks: NacksControlValue | undefined;
    /** The child's NACK, which this relay forwards toward the origin. */
    readonly upwardEffects: readonly ALInboundDurableEffectWrite[];
    readonly acceptance: ALControlAcceptance;
    readonly controlExpireAtTimestamp: number;
    readonly pendingExpireAtTimestamp: number;
}

/**
 * A relay forwards a child's NACK upward as it forwards a child's ACK (PL9). An outside-audience NACK also records its
 * recipient outside on the row and joins the NACK history a retried copy forwards again; a gap NACK changes nothing
 * here (S4ii-R3): the relay keeps no ordering record, and the origin's repair reaches the recipient through the
 * relay's forward.
 */
export function computeALInboundNackAdmission(
    read: ALInboundNackAdmissionRead,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundNackAdmissionCandidate {
    const outside = isALOutsideAudienceNackReason(read.nack.reason);
    const pending = read.pending !== undefined && outside
        ? acceptALPendingOutsideAudienceNack(read.pending, read.nack)
        : undefined;
    const row = pending ?? read.pending;
    const retainedNacks = read.nacks.slice(-(AL_MESSAGE_RESOURCE_LIMITS.collectionEntries - 1));
    return {
        read,
        pending: pending === undefined ? undefined : { kind: 'pending', value: pending },
        nacks: outside ? { kind: 'nacks', values: [...retainedNacks, read.nack] } : undefined,
        upwardEffects: row === undefined ? [] : toALInboundUpwardControlWork(
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
            [{ kind: 'forwarded', control: { type: 'nack', payload: read.nack } }],
            retention
        ),
        acceptance: { handled: true, completedPendingAcks: [] },
        controlExpireAtTimestamp: toExpireAtTimestampFromNow(retention.controlHistoryTtlMs, read.nowMs),
        pendingExpireAtTimestamp: resolveExpireAtTimestampWithFallback(
            pending?.expireAtTimestamp,
            retention.controlPendingTtlMs,
            read.nowMs
        )
    };
}

/** A child's gap NACK about a stored message that asked for no receipt, for which the relay keeps no row (6c). */
export interface ALInboundUnreceiptedGapNackAdmissionRead {
    readonly namespace: string;
    readonly nack: ALNackPayload & Readonly<{ reason: 'gap'; }>;
    /** The stored message the NACK names. */
    readonly msg: ALMessage;
    readonly owner: ALInboundMessageOwner;
    /** The peer the message arrived from, toward which the relay forwards the NACK. */
    readonly parentPeerId: string;
    /** The next hops the relay passes a copy of the message down to: the children whose gap NACK it relays. */
    readonly childPeerIds: readonly string[];
    readonly nowMs: number;
    readonly controlMsgId: string;
    readonly traceId: string;
}

/**
 * A relay forwards a child's gap NACK about a message that asked for no receipt each time it admits one, and records
 * nothing: the origin answers a repeat of a numbered request `duplicate` and charges nothing for it.
 */
export function computeALInboundUnreceiptedGapNackAdmission(
    read: ALInboundUnreceiptedGapNackAdmissionRead,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundNackAdmissionCandidate {
    const { namespace, nack, owner, nowMs, controlMsgId, traceId } = read;
    // The commit observes the message's control rows absent: a message that asked for no receipt writes none.
    return {
        read: {
            namespace,
            nack,
            controlOwners: undefined,
            owner,
            pending: undefined,
            acks: [],
            nacks: [],
            nowMs,
            controlMsgId,
            traceId
        },
        pending: undefined,
        nacks: undefined,
        upwardEffects: toALInboundUpwardControlWork(
            {
                namespace,
                msgId: nack.msgId,
                owner,
                relayPeerId: nack.toPeerId,
                pending: {
                    toPeerId: read.parentPeerId,
                    expireAtTimestamp: resolveALMessageExpireAtMs(read.msg),
                    upwardAudiencePeerIds: resolveALFrozenMulticastAudience(read.msg.targets)?.recipientPeerIds
                },
                nowMs,
                controlMsgId,
                traceId
            },
            [{ kind: 'forwarded', control: { type: 'nack', payload: nack } }],
            retention
        ),
        acceptance: { handled: true, completedPendingAcks: [] },
        controlExpireAtTimestamp: toExpireAtTimestampFromNow(retention.controlHistoryTtlMs, nowMs),
        pendingExpireAtTimestamp: resolveExpireAtTimestampWithFallback(undefined, retention.controlPendingTtlMs, nowMs)
    };
}

/** One conditional commit: the row that records the recipient and its NACK history, if any, and the forwarded NACK. */
export function toALInboundNackCommitBundle(candidate: ALInboundNackAdmissionCandidate): ALInboundCommitBundle {
    const { nack, owner } = candidate.read;
    const subject = { msgId: nack.msgId, senderId: owner.senderId };
    const mutations: readonly ALInboundAdmissionMutation[] = [
        ...(candidate.nacks === undefined ? [] : [{
            kind: 'set-control-nacks' as const,
            ...subject,
            value: candidate.nacks,
            expireAtTimestamp: candidate.controlExpireAtTimestamp
        }]),
        ...(candidate.pending === undefined ? [] : [{
            kind: 'set-control-pending' as const,
            ...subject,
            value: candidate.pending,
            expireAtTimestamp: candidate.pendingExpireAtTimestamp
        }])
    ];
    return {
        admissionExpiresAtMs: null,
        senderId: owner.senderId,
        observations: toALInboundControlObservations(nack.msgId, candidate.read),
        mutations,
        durableEffects: candidate.upwardEffects
    };
}
