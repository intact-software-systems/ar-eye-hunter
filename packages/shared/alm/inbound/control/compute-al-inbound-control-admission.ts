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
    AcksControlValue,
    ALInboundAdmissionObservations,
    ALInboundCommitBundle,
    ALInboundControlOwnerIndex,
    ALInboundDurableEffectWrite,
    ALInboundMessageOwner,
    PendingControlValue
} from '../al-inbound-admission-store.ts';
import { computeALInboundWorkEntry } from '../al-inbound-work-entry.ts';
import { acceptALPendingAckPayload } from '../transition-al-pending-ack.ts';

export interface ALInboundControlAdmissionRead {
    readonly namespace: string;
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
    readonly completedEffect: ALInboundDurableEffectWrite | undefined;
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
        completedEffect: completed ? computeCompletedAcknowledgementWork(read, completed, retention) : undefined,
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
        durableEffects: candidate.completedEffect === undefined ? [] : [candidate.completedEffect]
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

function computeCompletedAcknowledgementWork(
    read: ALInboundControlAdmissionRead,
    completed: ALCompletedPendingAck,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundDurableEffectWrite {
    return computeALInboundWorkEntry({
        namespace: read.namespace,
        observedAtMs: read.nowMs,
        effectId: toInboundEffectId('ack', completed.msgId, completed.toPeerId, completed.status, read.controlMsgId),
        expireAtTimestamp: resolveExpireAtTimestampWithFallback(
            completed.expireAtTimestamp,
            retention.durableEffectTtlMs,
            read.nowMs
        ),
        payload: {
            kind: 'send-control',
            msg: newALAckControlMessage(
                { v: 2, msgId: read.controlMsgId, senderId: read.ack.toPeerId, ts: read.nowMs },
                {
                    fromPeerId: read.ack.toPeerId,
                    toPeerId: completed.toPeerId,
                    ackedMsgId: completed.msgId,
                    status: completed.status,
                    observedAtEpochMs: read.nowMs
                }
            )
        }
    });
}

function toInboundEffectId(...parts: readonly (number | string)[]): string {
    return parts.map((part) => encodeURIComponent(String(part))).join(':');
}
