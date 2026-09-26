import { isALHopCompletionAck, type ALAckPayload } from '../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALReceiptMode } from '../../al-contracts/al-policy.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundSettlementFact
} from './al-outbound-message-runtime.ts';

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
 * The acknowledgement a receipt row states. Its peers are next hops under `hop` and `subtree` and
 * logical recipients under `receiver`; the origin tracks no second set, so the hop and recipient lists
 * name the same peers in every mode.
 */
export function toALOutboundAcknowledgementFact(
    snapshot: ALOutboundPendingAckSnapshot,
    complete: boolean
): ALOutboundSettlementFact {
    const unconfirmed = snapshot.expectedPeerIds.filter((peerId) => !snapshot.ackedPeerIds.includes(peerId));
    return {
        kind: 'acknowledgement',
        msgId: snapshot.msgId,
        mode: snapshot.mode,
        confirmedHopPeerIds: snapshot.ackedPeerIds,
        unconfirmedHopPeerIds: unconfirmed,
        expectedRecipientPeerIds: snapshot.expectedPeerIds,
        confirmedRecipientPeerIds: snapshot.ackedPeerIds,
        unconfirmedRecipientPeerIds: unconfirmed,
        complete
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
    return {
        kind: 'acknowledgement',
        msgId: plan.msg.id.msgId,
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: [],
        confirmedRecipientPeerIds: [],
        unconfirmedRecipientPeerIds: [],
        complete: true
    };
}
