import type {
    ALAckPayload,
    ALCompletedPendingAck,
    ALPendingAckSnapshot
} from '../../al-contracts/al-control.ts';

export interface TrackALPendingAckSnapshotInput {
    readonly msgId: string;
    readonly current: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly toPeerId: string;
    readonly expectedFromPeerIds: readonly string[];
    readonly localReady: boolean;
    readonly expireAtTimestamp: number | undefined;
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
}

export function trackALPendingAckSnapshot(
    input: TrackALPendingAckSnapshotInput
): ALPendingAckTransition {
    const expectedFromPeerIds = new Set(input.current?.expectedFromPeerIds ?? []);
    for (const peerId of input.expectedFromPeerIds) {
        expectedFromPeerIds.add(peerId);
    }

    const ackedFromPeerIds = new Set(input.current?.ackedFromPeerIds ?? []);
    for (const ack of input.acks) {
        if (expectedFromPeerIds.size === 0 || expectedFromPeerIds.has(ack.fromPeerId)) {
            ackedFromPeerIds.add(ack.fromPeerId);
        }
    }

    return finalizeALPendingAckTransition(input.msgId, {
        toPeerId: input.toPeerId,
        status: 'subtree-complete',
        localReady: (input.current?.localReady ?? false) || input.localReady,
        expectedFromPeerIds: [...expectedFromPeerIds],
        ackedFromPeerIds: [...ackedFromPeerIds],
        expireAtTimestamp: input.expireAtTimestamp ?? input.current?.expireAtTimestamp
    });
}

export function markALPendingAckLocalReadySnapshot(
    input: MarkALPendingAckLocalReadySnapshotInput
): ALPendingAckTransition {
    if (!input.current) {
        return {};
    }

    return trackALPendingAckSnapshot({
        msgId: input.msgId,
        current: input.current,
        acks: input.acks,
        toPeerId: input.current.toPeerId,
        expectedFromPeerIds: input.current.expectedFromPeerIds,
        localReady: true,
        expireAtTimestamp: input.current.expireAtTimestamp
    });
}

export function acceptALPendingAckPayload(
    input: AcceptALPendingAckPayloadInput
): ALPendingAckTransition {
    if (!input.current) {
        return {};
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
        expireAtTimestamp: input.current.expireAtTimestamp
    });
}

function finalizeALPendingAckTransition(
    msgId: string,
    pending: ALPendingAckSnapshot
): ALPendingAckTransition {
    if (!pending.localReady) {
        return { pending };
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
                expireAtTimestamp: pending.expireAtTimestamp
            }
        }
        : { pending };
}
