import type { ALAckPayload } from '../../al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALOutboundAckTrackingPlan } from './al-outbound-message-runtime.ts';

export interface AppendUniqueALAckInput {
    readonly current: readonly ALAckPayload[];
    readonly next: ALAckPayload;
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

export function appendUniqueALAck(
    input: AppendUniqueALAckInput
): readonly ALAckPayload[] {
    return input.current.some((ack) => ack.fromPeerId === input.next.fromPeerId && ack.status === input.next.status)
        ? input.current
        : [...input.current, input.next];
}

export function trackALOutboundPendingAckSnapshot(
    input: TrackALOutboundPendingAckSnapshotInput
): ALOutboundPendingAckSnapshot | undefined {
    const mode = input.tracking.mode ?? 'merge';
    const expectedPeerIds = new Set(mode === 'replace' ? [] : input.current?.expectedPeerIds);
    const ackedPeerIds = new Set(mode === 'replace' ? [] : input.current?.ackedPeerIds);
    for (const peerId of input.tracking.expectedPeerIds) {
        expectedPeerIds.add(peerId);
    }
    for (const ack of input.acks) {
        if (expectedPeerIds.size === 0 || expectedPeerIds.has(ack.fromPeerId)) {
            ackedPeerIds.add(ack.fromPeerId);
        }
    }
    if (mode === 'replace' && input.current) {
        for (const peerId of input.current.ackedPeerIds) {
            if (expectedPeerIds.has(peerId)) {
                ackedPeerIds.add(peerId);
            }
        }
    }

    const pending: ALOutboundPendingAckSnapshot = {
        msgId: input.msgId,
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

    const ackedPeerIds = new Set(input.current.ackedPeerIds);
    for (const ack of [input.ack, ...input.acks]) {
        if (input.current.expectedPeerIds.length === 0 || input.current.expectedPeerIds.includes(ack.fromPeerId)) {
            ackedPeerIds.add(ack.fromPeerId);
        }
    }
    return { ...input.current, ackedPeerIds: [...ackedPeerIds] };
}

export function toALOutboundPendingAckExpireAtTimestamp(
    snapshot: ALOutboundPendingAckSnapshot
): number {
    const remainingTimeoutWindows = Math.max(1, snapshot.maxAttempts - snapshot.attempts + 1);
    return snapshot.deadlineAtMs + snapshot.timeoutMs * remainingTimeoutWindows;
}

export function isALOutboundReceiptComplete(
    pending: ALOutboundPendingAckSnapshot
): boolean {
    return pending.expectedPeerIds.length === 0 ||
        pending.expectedPeerIds.every((peerId) => pending.ackedPeerIds.includes(peerId));
}
