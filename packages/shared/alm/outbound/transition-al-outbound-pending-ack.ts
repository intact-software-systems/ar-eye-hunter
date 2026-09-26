import { isALHopCompletionAck, type ALAckPayload } from '../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALReceiptMode } from '../../al-contracts/al-policy.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundSettlementFact
} from './al-outbound-message-runtime.ts';

/**
 * What one peer knows of the relay tree: its own next hops, and those whose subtree completed (a leaf
 * that delivered, or a relay whose terminal ACK arrived). No peer sees the tree beyond its own hops.
 */
export interface OverlayTree {
    readonly nextHopPeerIds: readonly string[];
    readonly completedHopPeerIds: readonly string[];
}

/** A receipt row as far as its acknowledgement states it, with the local hop view of its origin. */
export interface ToALOutboundAcknowledgementFactInput {
    readonly receipt: Pick<ALOutboundPendingAckSnapshot, 'msgId' | 'mode' | 'expectedPeerIds' | 'ackedPeerIds'>;
    readonly hops: OverlayTree;
    readonly complete: boolean;
}

export interface TrackALOutboundPendingAckSnapshotInput {
    readonly msgId: string;
    readonly current: ALOutboundPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly tracking: ALOutboundAckTrackingPlan;
    readonly nowMs: number;
}

export interface AcceptALOutboundPendingAckSnapshotInput {
    readonly current: ALOutboundPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly ack: ALAckPayload;
}

export function trackALOutboundPendingAckSnapshot(
    input: TrackALOutboundPendingAckSnapshotInput
): ALOutboundPendingAckSnapshot | undefined {
    const { mode } = input.tracking;
    const replace = input.tracking.expectedPeerIdsUpdate === 'replace';
    const expectedPeerIds = new Set(replace ? [] : input.current?.expectedPeerIds);
    const ackedPeerIds = new Set(replace ? [] : input.current?.ackedPeerIds);
    for (const peerId of input.tracking.expectedPeerIds) {
        expectedPeerIds.add(peerId);
    }
    for (const ack of input.acks) {
        const peerId = toALOutboundAckedPeerId(mode, ack);
        if (peerId !== undefined && (expectedPeerIds.size === 0 || expectedPeerIds.has(peerId))) {
            ackedPeerIds.add(peerId);
        }
    }
    if (replace && input.current) {
        for (const peerId of input.current.ackedPeerIds) {
            if (expectedPeerIds.has(peerId)) {
                ackedPeerIds.add(peerId);
            }
        }
    }

    const pending: ALOutboundPendingAckSnapshot = {
        msgId: input.msgId,
        mode,
        expectedPeerIds: [...expectedPeerIds],
        ackedPeerIds: [...ackedPeerIds],
        timeoutMs: input.tracking.timeoutMs,
        maxAttempts: input.tracking.maxAttempts,
        attempts: input.current?.attempts ?? 0,
        deadlineAtMs: input.nowMs + input.tracking.timeoutMs
    };
    return isALOutboundReceiptComplete(pending) ? undefined : pending;
}

export function acceptALOutboundPendingAckSnapshot(
    input: AcceptALOutboundPendingAckSnapshotInput
): ALOutboundPendingAckSnapshot | undefined {
    if (!input.current) {
        return undefined;
    }

    const { mode, expectedPeerIds } = input.current;
    const ackedPeerIds = new Set(input.current.ackedPeerIds);
    for (const ack of [input.ack, ...input.acks]) {
        const peerId = toALOutboundAckedPeerId(mode, ack);
        if (peerId !== undefined && (expectedPeerIds.length === 0 || expectedPeerIds.includes(peerId))) {
            ackedPeerIds.add(peerId);
        }
    }
    return { ...input.current, ackedPeerIds: [...ackedPeerIds] };
}

/**
 * The peer an ACK confirms in a receipt of this mode: the logical recipient it speaks for under
 * `receiver`, and the hop that sent it otherwise. A hop ACK names the hop itself, so it never stands in
 * for a logical recipient it did not name. Under `subtree` only the completion ACK of the hop itself
 * confirms it, never an ACK it relays for a recipient below it.
 */
export function toALOutboundAckedPeerId(mode: ALReceiptMode, ack: ALAckPayload): string | undefined {
    switch (mode) {
        case 'receiver':
            return ack.logicalRecipientPeerId;
        case 'subtree':
            return isALHopCompletionAck(ack) ? ack.fromPeerId : undefined;
        case 'hop':
            return ack.fromPeerId;
    }
}

/** The next hops whose subtree these ACKs completed: what the sender knows of the tree below it. */
export function toALOutboundCompletedHopPeerIds(acks: readonly ALAckPayload[]): readonly string[] {
    return [...new Set(acks.filter(isALHopCompletionAck).map((ack) => ack.fromPeerId))];
}

/**
 * When the last `ack-timeout` window closes, never past the message deadline: no retransmission is
 * scheduled after it. The receipt itself expires at the deadline, however early this schedule ends.
 */
export function toALOutboundAckRetryScheduleEndTimestamp(
    snapshot: ALOutboundPendingAckSnapshot,
    messageExpiresAtMs: number
): number {
    const remainingTimeoutWindows = Math.max(1, snapshot.maxAttempts - snapshot.attempts + 1);
    return Math.min(snapshot.deadlineAtMs + snapshot.timeoutMs * remainingTimeoutWindows, messageExpiresAtMs);
}

/**
 * The acknowledgement a receipt row states. Under `hop` and `subtree` the row counts next hops, so its
 * peers are both the hop and the recipient lists. Under `receiver` the row counts logical recipients,
 * and the hop lists come from the hop view alone: the completed hops, and the next hops still open.
 */
export function toALOutboundAcknowledgementFact(input: ToALOutboundAcknowledgementFactInput): ALOutboundSettlementFact {
    const { receipt, hops } = input;
    const unconfirmed = receipt.expectedPeerIds.filter((peerId) => !receipt.ackedPeerIds.includes(peerId));
    const receiverHops = receipt.mode === 'receiver';
    return {
        kind: 'acknowledgement',
        msgId: receipt.msgId,
        mode: receipt.mode,
        confirmedHopPeerIds: receiverHops ? hops.completedHopPeerIds : receipt.ackedPeerIds,
        unconfirmedHopPeerIds: receiverHops
            ? hops.nextHopPeerIds.filter((peerId) => !hops.completedHopPeerIds.includes(peerId))
            : unconfirmed,
        expectedRecipientPeerIds: receipt.expectedPeerIds,
        confirmedRecipientPeerIds: receipt.ackedPeerIds,
        unconfirmedRecipientPeerIds: unconfirmed,
        complete: input.complete
    };
}

export function isALOutboundReceiptComplete(
    pending: ALOutboundPendingAckSnapshot
): boolean {
    return pending.expectedPeerIds.length === 0 ||
        pending.expectedPeerIds.every((peerId) => pending.ackedPeerIds.includes(peerId));
}

/**
 * A `receiver` multicast frozen to an empty audience has nobody left to confirm it: its receipt is
 * complete at admission, with no row, as the WS server answers an empty audience.
 */
export function toALOutboundEmptyAudienceReceipt<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>
): ALOutboundSettlementFact | undefined {
    const frozen = resolveALFrozenMulticastAudience(plan.msg.targets);
    if (plan.dropReason || plan.ackTracking?.mode !== 'receiver' || frozen?.recipientPeerIds.length !== 0) {
        return undefined;
    }
    return toALOutboundAcknowledgementFact({
        receipt: { msgId: plan.msg.id.msgId, mode: 'receiver', expectedPeerIds: [], ackedPeerIds: [] },
        hops: { nextHopPeerIds: [], completedHopPeerIds: [] },
        complete: true
    });
}
