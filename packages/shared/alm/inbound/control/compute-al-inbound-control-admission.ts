import type {
    ALAckPayload,
    ALControlAcceptance,
    ALPendingAckSnapshot
} from '../../../al-contracts/al-control.ts';
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
import type { ALInboundDurableEffectWrite } from '../al-inbound-work-entry.ts';
import { acceptALPendingAckPayload, type ALPendingAckTransition } from '../transition-al-pending-ack.ts';
import type { AcksControlValue, PendingControlValue } from './al-inbound-control-rows.ts';
import { toALInboundUpwardControlWork } from './to-al-inbound-upward-control-work.ts';

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
    readonly traceId: string;
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
    const transition = acceptALPendingAckPayload({ current: read.pending, acks: read.acks, ack: read.ack });
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
        observations: toALInboundControlObservations(ack.ackedMsgId, candidate.read),
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

/** The rows a child's control decided on, which the conditional commit observes unchanged. */
export type ALInboundControlObservationSurface = Pick<
    ALInboundControlAdmissionRead,
    'owner' | 'pending' | 'acks' | 'controlOwners'
>;

export function toALInboundControlObservations(
    msgId: string,
    surface: ALInboundControlObservationSurface
): ALInboundAdmissionObservations {
    return {
        msgId,
        senderId: surface.owner.senderId,
        messageOwner: surface.owner,
        dedup: undefined,
        claim: undefined,
        ordering: undefined,
        buffered: undefined,
        deliveryProgress: undefined,
        supersedence: {},
        pendingAck: surface.pending,
        acks: surface.acks,
        controlOwners: surface.controlOwners
    };
}

/**
 * The relay sends the `not-subscribed` NACK a hop completion implied, one ACK per recipient its row relays upward,
 * then its own terminal ACK once its row completed (D40).
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
    return toALInboundUpwardControlWork(
        {
            namespace: read.namespace,
            msgId: read.ack.ackedMsgId,
            owner: read.owner,
            relayPeerId: read.ack.toPeerId,
            pending,
            nowMs: read.nowMs,
            controlMsgId: read.controlMsgId,
            traceId: read.traceId
        },
        [
            ...transition.relayedOutsidePeerIds.map((peerId) => ({
                kind: 'nack' as const,
                logicalRecipientPeerId: peerId,
                reason: 'not-subscribed' as const
            })),
            ...toALInboundUpwardAcks(transition).map((ack) => ({ kind: 'ack' as const, ack }))
        ],
        retention
    );
}
