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
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';
import type { ALInboundDurableEffectWrite } from '../al-inbound-work-entry.ts';
import { acceptALPendingOutsideAudienceNack } from '../transition-al-pending-ack.ts';
import type { NacksControlValue, PendingControlValue } from './al-inbound-control-rows.ts';
import { toALInboundControlObservations } from './compute-al-inbound-control-admission.ts';
import {
    toALInboundUpwardControlWork,
    type ALInboundUpwardControlContext
} from './to-al-inbound-upward-control-work.ts';

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
    /**
     * Read only for a gap NACK from a sender the row does not wait on: the lane names that sender this relay's child in
     * its accepted layout, as a new parent's is after a reshape (6d); `false` for any other NACK.
     */
    readonly isLayoutChild: boolean;
    readonly nowMs: number;
    readonly controlMsgId: string;
    readonly traceId: string;
}

export interface ALInboundNackAdmissionCandidate {
    readonly read: ALInboundNackAdmissionRead;
    /** The message-owner row the commit observes; absent for a message this relay holds nothing of (6d). */
    readonly observedMessageOwner: ALInboundMessageOwner | undefined;
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
        observedMessageOwner: read.owner,
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
    return toALInboundRowlessGapNackCandidate({
        read,
        observedMessageOwner: read.owner,
        upward: {
            toPeerId: read.parentPeerId,
            expireAtTimestamp: resolveALMessageExpireAtMs(read.msg),
            upwardAudiencePeerIds: resolveALFrozenMulticastAudience(read.msg.targets)?.recipientPeerIds
        }
    }, retention);
}

/** A child's gap NACK about a message this relay holds neither a row nor a copy of: a new parent after a reshape (6d). */
export interface ALInboundUnheldGapNackAdmissionRead {
    readonly namespace: string;
    readonly nack: ALNackPayload & Readonly<{ reason: 'gap'; }>;
    /** This relay's upstream peer toward the NACK's origin in its accepted layout, which names the sender its child. */
    readonly parent: ALInboundMessageRuntime.PeerSource;
    readonly nowMs: number;
    readonly controlMsgId: string;
    readonly traceId: string;
}

/**
 * A relay that holds nothing of the message forwards a child's gap NACK to its upstream peer each time it admits one,
 * and records nothing, as it does for a message that asked for no receipt; the NACK lives as long as a control's
 * retention allows, since the relay knows no deadline of the message.
 */
export function computeALInboundUnheldGapNackAdmission(
    read: ALInboundUnheldGapNackAdmissionRead,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundNackAdmissionCandidate {
    const { nack, parent } = read;
    // The upward NACK names the origin and goes back over the parent's carrier; no owner row exists to observe.
    const owner: ALInboundMessageOwner = {
        msgId: nack.msgId,
        senderId: nack.originPeerId,
        source: parent,
        supersedenceKey: null,
        deliveredLocally: false
    };
    return toALInboundRowlessGapNackCandidate({
        read: { ...read, owner },
        observedMessageOwner: undefined,
        upward: { toPeerId: parent.peerId, expireAtTimestamp: undefined, upwardAudiencePeerIds: undefined }
    }, retention);
}

/** A forward of a child's gap NACK the relay keeps no row for. */
interface ToALInboundRowlessGapNackCandidateInput {
    readonly read: Pick<
        ALInboundNackAdmissionRead,
        'namespace' | 'nack' | 'owner' | 'nowMs' | 'controlMsgId' | 'traceId'
    >;
    readonly observedMessageOwner: ALInboundMessageOwner | undefined;
    /** The parent the NACK goes to, how long it lives, and whom the origin counts. */
    readonly upward: ALInboundUpwardControlContext['pending'];
}

function toALInboundRowlessGapNackCandidate(
    input: ToALInboundRowlessGapNackCandidateInput,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundNackAdmissionCandidate {
    const { observedMessageOwner, upward } = input;
    const { namespace, nack, owner, nowMs, controlMsgId, traceId } = input.read;
    // The commit observes the message's control rows absent: a row-less forward writes none.
    return {
        read: {
            namespace,
            nack,
            controlOwners: undefined,
            owner,
            pending: undefined,
            acks: [],
            nacks: [],
            isLayoutChild: false,
            nowMs,
            controlMsgId,
            traceId
        },
        observedMessageOwner,
        pending: undefined,
        nacks: undefined,
        upwardEffects: toALInboundUpwardControlWork(
            {
                namespace,
                msgId: nack.msgId,
                owner,
                relayPeerId: nack.toPeerId,
                pending: upward,
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
        observations: {
            ...toALInboundControlObservations(nack.msgId, candidate.read),
            messageOwner: candidate.observedMessageOwner
        },
        mutations,
        durableEffects: candidate.upwardEffects
    };
}
