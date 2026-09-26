import type { ALAckStatus, ALPendingAckSnapshot } from '../../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import type { ALInboundAdmissionMutation, ALInboundMessageReadDto } from '../al-inbound-admission-store.ts';
import { toALInboundMessageReference } from '../al-inbound-canonical-message.ts';
import {
    toALInboundAckEffect,
    type ALInboundAckRecipient,
    type ALInboundEffectIntent
} from '../al-inbound-effect-intent.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import { isALPendingAckComplete } from '../transition-al-pending-ack.ts';

export interface ALInboundDuplicateChanges {
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly effects: readonly ALInboundEffectIntent[];
}

export interface ComputeALInboundDuplicateChangesInput {
    readonly selfPeerId: string;
    /** Whether the parent the relay row records is still a member of the room and reachable. */
    readonly recordedParentPresent: boolean;
}

interface ALInboundRepeatedAck {
    readonly toPeerId: string;
    readonly logicalRecipient: ALInboundAckRecipient;
    readonly status: ALAckStatus;
}

const NO_DUPLICATE_CHANGES: ALInboundDuplicateChanges = { mutations: [], effects: [] };

/**
 * A retried copy of a message this peer already admitted, addressed to this peer (D25). It is never
 * delivered again. A peer with no relay row sends its own ACK again. A relay answers its parent in full:
 * every ACK it already relayed again, since any of them may be the one the origin lost, then its terminal
 * ACK when its subtree completed, or the copy onward to the child hops it still waits on. A sibling sender
 * gets the terminal ACK of this peer at once, so its own row completes whatever the visited exclusion
 * missed (R-S2c-ii-8c). The origin, or any sender once the recorded parent left, becomes the parent of
 * the row, and is answered in full (R-S2c-ii-12); a former parent still present then gets the sibling
 * answer (R-S2c-ii-14).
 */
export function computeALInboundDuplicateChanges(
    read: ALInboundMessageReadDto,
    input: ComputeALInboundDuplicateChangesInput
): ALInboundDuplicateChanges {
    const { msg, plan, pendingAck } = read;
    const toPeerId = plan.ack.toPeerId;
    const nextHopPeerIds = msg.forwarding?.nextHopPeerIds ?? [];
    if (
        plan.dropReasonCode !== 'duplicate' || plan.ack.algo === 'none' || toPeerId === undefined ||
        nextHopPeerIds.length !== 1 || nextHopPeerIds[0] !== input.selfPeerId
    ) {
        return NO_DUPLICATE_CHANGES;
    }
    if (pendingAck === undefined) {
        const status = toOwnAckStatus(read, input.selfPeerId);
        return {
            mutations: [],
            effects: [toRepeatedAck(read, { toPeerId, logicalRecipient: { kind: 'self' }, status })]
        };
    }
    if (read.fromPeerId === pendingAck.toPeerId) {
        return { mutations: [], effects: toParentAnswer(read, pendingAck) };
    }
    if (!isReparentingSender(read, pendingAck, input.recordedParentPresent)) {
        const status = pendingAck.status;
        const toSibling = { toPeerId: read.fromPeerId, logicalRecipient: { kind: 'self' } as const, status };
        return { mutations: [], effects: [toRepeatedAck(read, toSibling)] };
    }
    const reparented = { ...pendingAck, toPeerId: read.fromPeerId };
    return {
        mutations: [toReparentedRowMutation(read, reparented)],
        effects: [
            ...toParentAnswer(read, reparented),
            ...(input.recordedParentPresent ? [toFormerParentRelease(read, pendingAck)] : [])
        ]
    };
}

/**
 * A former parent that is still present waits on this peer as its child, which now answers another parent:
 * it gets the sibling answer, so its own row completes and its own delivery is still confirmed (R-S2c-ii-14).
 */
function toFormerParentRelease(read: ALInboundMessageReadDto, pendingAck: ALPendingAckSnapshot): ALInboundEffectIntent {
    return toRepeatedAck(read, {
        toPeerId: pendingAck.toPeerId,
        logicalRecipient: { kind: 'self' },
        status: pendingAck.status
    });
}

/**
 * The origin is nobody's child, so its copy never comes from a sibling. Once the recorded parent left, the
 * sender is the parent of the new tree, unless it is a child hop of this peer, which would close a cycle.
 */
function isReparentingSender(
    read: ALInboundMessageReadDto,
    pendingAck: ALPendingAckSnapshot,
    recordedParentPresent: boolean
): boolean {
    if (read.fromPeerId === read.msg.id.senderId) {
        return true;
    }
    return !recordedParentPresent && !pendingAck.expectedFromPeerIds.includes(read.fromPeerId);
}

function toParentAnswer(
    read: ALInboundMessageReadDto,
    pendingAck: ALPendingAckSnapshot
): readonly ALInboundEffectIntent[] {
    const relayed = [...new Set(read.acks.map((ack) => ack.logicalRecipientPeerId))].map((peerId) =>
        toRepeatedAck(read, {
            toPeerId: pendingAck.toPeerId,
            logicalRecipient: { kind: 'relayed', peerId },
            status: 'forwarded'
        })
    );
    if (isALPendingAckComplete(pendingAck)) {
        return [
            ...relayed,
            toRepeatedAck(read, {
                toPeerId: pendingAck.toPeerId,
                logicalRecipient: { kind: 'self' },
                status: pendingAck.status
            })
        ];
    }
    const owedPeerIds = pendingAck.expectedFromPeerIds.filter((peerId) =>
        !pendingAck.ackedFromPeerIds.includes(peerId)
    );
    return owedPeerIds.length === 0 ? relayed : [...relayed, toRetriedForward(read, owedPeerIds)];
}

function toReparentedRowMutation(
    read: ALInboundMessageReadDto,
    pendingAck: ALPendingAckSnapshot
): ALInboundAdmissionMutation {
    return {
        kind: 'set-control-pending',
        msgId: read.msg.id.msgId,
        senderId: read.msg.id.senderId,
        value: { kind: 'pending', value: pendingAck },
        expireAtTimestamp: resolveExpireAtTimestampWithFallback(
            pendingAck.expireAtTimestamp,
            read.retention.controlPendingTtlMs,
            read.nowMs
        )
    };
}

/** A peer outside the frozen audience delivered nothing: its ACK only ends its own empty subtree. */
function toOwnAckStatus(read: ALInboundMessageReadDto, selfPeerId: string): ALAckStatus {
    const frozen = resolveALFrozenMulticastAudience(read.msg.targets);
    return frozen === undefined || frozen.recipientPeerIds.includes(selfPeerId) ? 'delivered' : 'subtree-complete';
}

function toRepeatedAck(read: ALInboundMessageReadDto, repeated: ALInboundRepeatedAck): ALInboundEffectIntent {
    const ack = toALInboundAckEffect({
        ...repeated,
        ackedMsgId: read.msg.id.msgId,
        originPeerId: read.msg.id.senderId,
        expireAtTimestamp: resolveALMessageExpireAtMs(read.msg, read.plan.effective),
        carrier: toALDeliveryCarrier(read.source)
    });
    return { ...ack, effectId: toRetriedEffectId(ack.effectId, read.nowMs) };
}

function toRetriedForward(read: ALInboundMessageReadDto, owedPeerIds: readonly string[]): ALInboundEffectIntent {
    const { msg } = read;
    return {
        effectId: toRetriedEffectId(
            ['forward', msg.id.senderId, msg.id.msgId, read.fromPeerId].map(encodeURIComponent).join(':'),
            read.nowMs
        ),
        expireAtTimestamp: resolveALMessageExpireAtMs(msg, read.plan.effective),
        carrier: toALDeliveryCarrier(read.source),
        payload: {
            kind: 'forward-message',
            message: toALInboundMessageReference(msg),
            fromPeerId: read.fromPeerId,
            retryPeerIds: owedPeerIds
        }
    };
}

/** Each retried copy is its own arrival, so its work never collides with the rows the first copy wrote. */
function toRetriedEffectId(effectId: string, nowMs: number): string {
    return `${effectId}:retried:${nowMs}`;
}
