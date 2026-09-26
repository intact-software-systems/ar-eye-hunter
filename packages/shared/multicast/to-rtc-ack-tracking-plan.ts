import type { ALQosEffectivePolicy } from '../al-contracts/al-policy.ts';
import type { ALOutboundAckTrackingPlan } from '../alm/outbound/al-outbound-message-runtime.ts';

/** The receipt an RTC dispatch tracks: the send's own ack algorithm, over the peers it expects. */
export function toRtcAckTrackingPlan(
    effective: ALQosEffectivePolicy,
    expectedPeerIds: readonly string[],
    expectedPeerIdsUpdate?: 'merge' | 'replace'
): ALOutboundAckTrackingPlan | undefined {
    if (effective.ack.algo === 'none') {
        return undefined;
    }

    const nextHopPeerIds = [...new Set(expectedPeerIds)];
    return {
        enabled: true,
        timeoutMs: effective.ack.opts.timeoutMs,
        maxAttempts: effective.retry.algo === 'none'
            ? 0
            : effective.retry.opts.maxAttempts,
        expectedPeerIds: nextHopPeerIds,
        expectedPeerIdsUpdate,
        nextHopPeerIds,
        mode: effective.ack.algo
    };
}
