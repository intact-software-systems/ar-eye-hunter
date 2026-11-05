import {
    isALHopCompletionAck,
    type ALAckPayload
} from '../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALAckAlgo, ALReceiptMode } from '../../al-contracts/al-policy.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import { isALRecipientConfirmationAck } from '../delivery/is-al-recipient-confirmation-ack.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundSettlementFact
} from './al-outbound-message-runtime.ts';
import { toALOutboundReceiptClasses } from './control/to-al-outbound-receipt-classes.ts';

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
    readonly receipt: Pick<
        ALOutboundPendingAckSnapshot,
        'msgId' | 'mode' | 'expectedPeerIds' | 'ackedPeerIds' | 'outsideAudiencePeerIds'
    >;
    readonly hops: OverlayTree;
    readonly complete: boolean;
    /** The trace of the request whose commit moved the receipt. */
    readonly traceId: string;
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

/** Whether a dispatch writes a receipt row for this tracking: somebody to expect, and a window to wait in. */
export function isALOutboundAckTrackingWritable(tracking: ALOutboundAckTrackingPlan): boolean {
    return tracking.enabled && tracking.expectedPeerIds.length > 0 && tracking.timeoutMs > 0;
}

/**
 * The receipt an admission tracks: the mode of the receipt row its commit writes, `none` when it writes
 * none (R-S3a-4, and a `qos.ack` timeout of 0). A `receiver` or `leader` receipt that expects nobody yet is the
 * exception: the WS server's `admitted` receipt creates its row, and an empty frozen audience completes
 * it at admission.
 */
export function toALOutboundTrackedReceiptAlgo(
    ackTracking: ALOutboundAckTrackingPlan | null | undefined
): ALAckAlgo {
    if (ackTracking?.enabled !== true) {
        return 'none';
    }
    if (isALLogicalReceiptMode(ackTracking.mode) && ackTracking.expectedPeerIds.length === 0) {
        return ackTracking.mode;
    }
    return isALOutboundAckTrackingWritable(ackTracking) ? ackTracking.mode : 'none';
}

/** The receipt row a dispatch's tracking leaves, complete or not. */
export function toALOutboundTrackedReceipt(
    input: TrackALOutboundPendingAckSnapshotInput
): ALOutboundPendingAckSnapshot {
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
    const outsideAudiencePeerIds = (input.current?.outsideAudiencePeerIds ?? [])
        .filter((peerId) => expectedPeerIds.has(peerId));
    return {
        msgId: input.msgId,
        mode,
        expectedPeerIds: [...expectedPeerIds],
        ackedPeerIds: [...ackedPeerIds],
        outsideAudiencePeerIds,
        timeoutMs: input.tracking.timeoutMs,
        maxAttempts: input.tracking.maxAttempts,
        attempts: input.current?.attempts ?? 0,
        deadlineAtMs: input.nowMs + input.tracking.timeoutMs
    };
}

export function trackALOutboundPendingAckSnapshot(
    input: TrackALOutboundPendingAckSnapshotInput
): ALOutboundPendingAckSnapshot | undefined {
    const pending = toALOutboundTrackedReceipt(input);
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

/** An outside-audience NACK places its recipient outside the audience: neither confirmed nor still owed (PL10). */
export function acceptALOutboundOutsideAudienceNack(
    current: ALOutboundPendingAckSnapshot,
    logicalRecipientPeerId: string
): ALOutboundPendingAckSnapshot {
    return {
        ...current,
        outsideAudiencePeerIds: [...new Set([...current.outsideAudiencePeerIds, logicalRecipientPeerId])]
    };
}

/**
 * The peer an ACK confirms in a receipt of this mode: the logical recipient it speaks for under
 * `receiver` and `leader`, unless it is the hop completion of a recipient that delivered nothing, and the hop that
 * sent it otherwise. A hop ACK names the hop itself, so it never stands in
 * for a logical recipient it did not name. Under `subtree` only the completion ACK of the hop itself
 * confirms it, never an ACK it relays for a recipient below it.
 */
export function toALOutboundAckedPeerId(mode: ALReceiptMode, ack: ALAckPayload): string | undefined {
    switch (mode) {
        case 'receiver':
        case 'leader':
            return isALRecipientConfirmationAck(ack) ? ack.logicalRecipientPeerId : undefined;
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
 * The acknowledgement a receipt row states. Under `hop` and `subtree` the row counts next hops, so its
 * peers are both the hop and the recipient lists. Under `receiver` and `leader` the row counts logical recipients,
 * and the hop lists come from the hop view alone: the completed hops, and the next hops still open.
 */
export function toALOutboundAcknowledgementFact(input: ToALOutboundAcknowledgementFactInput): ALOutboundSettlementFact {
    const { receipt, hops } = input;
    const classes = toALOutboundReceiptClasses(receipt);
    const receiverHops = isALLogicalReceiptMode(receipt.mode);
    return {
        kind: 'acknowledgement',
        msgId: receipt.msgId,
        traceId: input.traceId,
        mode: receipt.mode,
        confirmedHopPeerIds: receiverHops ? hops.completedHopPeerIds : classes.confirmedPeerIds,
        unconfirmedHopPeerIds: receiverHops
            ? hops.nextHopPeerIds.filter((peerId) => !hops.completedHopPeerIds.includes(peerId))
            : classes.unconfirmedPeerIds,
        expectedRecipientPeerIds: receipt.expectedPeerIds,
        confirmedRecipientPeerIds: classes.confirmedPeerIds,
        unconfirmedRecipientPeerIds: classes.unconfirmedPeerIds,
        outsideAudienceRecipientPeerIds: classes.outsideAudiencePeerIds,
        complete: input.complete
    };
}

/**
 * Every expected peer is acked or outside the audience, and somebody confirmed: a receipt whose every recipient is
 * outside confirmed nothing, so it stays open until its deadline. A receipt that expected nobody is complete.
 */
export function isALOutboundReceiptComplete(
    pending: Pick<ALOutboundPendingAckSnapshot, 'expectedPeerIds' | 'ackedPeerIds' | 'outsideAudiencePeerIds'>
): boolean {
    const classes = toALOutboundReceiptClasses(pending);
    return pending.expectedPeerIds.length === 0 ||
        (classes.confirmedPeerIds.length > 0 && classes.unconfirmedPeerIds.length === 0);
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
        receipt: {
            msgId: plan.msg.id.msgId,
            mode: 'receiver',
            expectedPeerIds: [],
            ackedPeerIds: [],
            outsideAudiencePeerIds: []
        },
        hops: { nextHopPeerIds: [], completedHopPeerIds: [] },
        complete: true,
        traceId: plan.msg.id.traceId
    });
}
