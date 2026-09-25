import type { ALAckPayload } from '../../al-contracts/al-control.ts';
import type { ALReceiptMode } from '../../al-contracts/al-policy.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALOutboundAckTrackingPlan } from './al-outbound-message-runtime.ts';

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
        if (expectedPeerIds.size === 0 || expectedPeerIds.has(peerId)) {
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
        if (expectedPeerIds.length === 0 || expectedPeerIds.includes(peerId)) {
            ackedPeerIds.add(peerId);
        }
    }
    return { ...input.current, ackedPeerIds: [...ackedPeerIds] };
}

/**
 * The peer an ACK confirms in a receipt of this mode: the logical recipient it speaks for under
 * `receiver`, the hop that sent it otherwise. A hop ACK names the hop itself, so it never stands in
 * for a logical recipient it did not name.
 */
export function toALOutboundAckedPeerId(mode: ALReceiptMode, ack: ALAckPayload): string {
    return mode === 'receiver' ? ack.logicalRecipientPeerId : ack.fromPeerId;
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

export function isALOutboundReceiptComplete(
    pending: ALOutboundPendingAckSnapshot
): boolean {
    return pending.expectedPeerIds.length === 0 ||
        pending.expectedPeerIds.every((peerId) => pending.ackedPeerIds.includes(peerId));
}
