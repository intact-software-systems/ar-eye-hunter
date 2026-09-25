import type {
    ALAckPayload,
    ALCompletedPendingAck,
    ALPendingAckSnapshot
} from '../../al-contracts/al-control.ts';
import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';

export interface TrackALPendingAckSnapshotInput {
    readonly msgId: string;
    readonly current: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly toPeerId: string;
    readonly expectedFromPeerIds: readonly string[];
    readonly localReady: boolean;
    readonly expireAtTimestamp: number | undefined;
    readonly carrier: ALDeliveryCarrier;
}

export interface MarkALPendingAckLocalReadySnapshotInput {
    readonly msgId: string;
    readonly current: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
}

export interface AcceptALPendingAckPayloadInput {
    readonly current: ALPendingAckSnapshot | undefined;
    readonly nextAcks: readonly ALAckPayload[];
    readonly ack: ALAckPayload;
}

export interface ALPendingAckTransition {
    readonly pending?: ALPendingAckSnapshot;
    readonly completed?: ALCompletedPendingAck;
    /** One admitted ACK per logical recipient the completed receipt speaks for (D40); empty while pending. */
    readonly completedAcks: readonly ALAckPayload[];
}

export function trackALPendingAckSnapshot(
    input: TrackALPendingAckSnapshotInput
): ALPendingAckTransition {
    const expireAtTimestamp = input.expireAtTimestamp ?? input.current?.expireAtTimestamp;
    const expectedFromPeerIds = new Set(input.current?.expectedFromPeerIds ?? []);
    for (const peerId of input.expectedFromPeerIds) {
        expectedFromPeerIds.add(peerId);
    }

    const ackedFromPeerIds = new Set(input.current?.ackedFromPeerIds ?? []);
    const countedAcks = input.acks.filter((ack) =>
        expectedFromPeerIds.size === 0 || expectedFromPeerIds.has(ack.fromPeerId)
    );
    for (const ack of countedAcks) {
        ackedFromPeerIds.add(ack.fromPeerId);
    }

    return finalizeALPendingAckTransition(input.msgId, countedAcks, {
        toPeerId: input.toPeerId,
        status: 'subtree-complete',
        localReady: (input.current?.localReady ?? false) || input.localReady,
        expectedFromPeerIds: [...expectedFromPeerIds],
        ackedFromPeerIds: [...ackedFromPeerIds],
        ...(expireAtTimestamp === undefined ? {} : { expireAtTimestamp }),
        carrier: input.carrier
    });
}

export function markALPendingAckLocalReadySnapshot(
    input: MarkALPendingAckLocalReadySnapshotInput
): ALPendingAckTransition {
    if (!input.current) {
        return { completedAcks: [] };
    }

    return trackALPendingAckSnapshot({
        msgId: input.msgId,
        current: input.current,
        acks: input.acks,
        toPeerId: input.current.toPeerId,
        expectedFromPeerIds: input.current.expectedFromPeerIds,
        localReady: true,
        expireAtTimestamp: input.current.expireAtTimestamp,
        carrier: input.current.carrier
    });
}

export function acceptALPendingAckPayload(
    input: AcceptALPendingAckPayloadInput
): ALPendingAckTransition {
    if (!input.current) {
        return { completedAcks: [] };
    }

    const ackedFromPeerIds = new Set(input.current.ackedFromPeerIds);
    if (
        input.current.expectedFromPeerIds.length === 0 ||
        input.current.expectedFromPeerIds.includes(input.ack.fromPeerId)
    ) {
        ackedFromPeerIds.add(input.ack.fromPeerId);
    }

    return trackALPendingAckSnapshot({
        msgId: input.ack.ackedMsgId,
        current: { ...input.current, ackedFromPeerIds: [...ackedFromPeerIds] },
        acks: input.nextAcks,
        toPeerId: input.current.toPeerId,
        expectedFromPeerIds: input.current.expectedFromPeerIds,
        localReady: input.current.localReady,
        expireAtTimestamp: input.current.expireAtTimestamp,
        carrier: input.current.carrier
    });
}

function finalizeALPendingAckTransition(
    msgId: string,
    countedAcks: readonly ALAckPayload[],
    pending: ALPendingAckSnapshot
): ALPendingAckTransition {
    if (!pending.localReady) {
        return { pending, completedAcks: [] };
    }

    const ackedFromPeerIds = new Set(pending.ackedFromPeerIds);
    const isComplete = pending.expectedFromPeerIds.length === 0 ||
        pending.expectedFromPeerIds.every((peerId) => ackedFromPeerIds.has(peerId));
    return isComplete
        ? {
            completed: {
                msgId,
                toPeerId: pending.toPeerId,
                status: pending.status,
                ...(pending.expireAtTimestamp === undefined ? {} : { expireAtTimestamp: pending.expireAtTimestamp })
            },
            completedAcks: resolveALAckPerLogicalRecipient(countedAcks)
        }
        : { pending, completedAcks: [] };
}

function resolveALAckPerLogicalRecipient(acks: readonly ALAckPayload[]): readonly ALAckPayload[] {
    const byRecipient = new Map<string, ALAckPayload>();
    for (const ack of acks) {
        if (!byRecipient.has(ack.logicalRecipientPeerId)) {
            byRecipient.set(ack.logicalRecipientPeerId, ack);
        }
    }
    return [...byRecipient.values()];
}
