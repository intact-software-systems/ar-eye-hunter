import type { ALMessage } from '../al-contracts/al-contract.ts';
import { resolveSupersedenceKey, type ALQosEffectivePolicy } from '../al-contracts/al-policy.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundRepairTrackingPlan,
    ALOutboundRetryTrackingPlan,
    ALOutboundSupersedenceTrackingPlan
} from '../alm/outbound/al-outbound-message-runtime.ts';

interface RtcOutboundTracking {
    readonly ackTracking: ALOutboundAckTrackingPlan | undefined;
    readonly retryTracking: ALOutboundRetryTrackingPlan | undefined;
    readonly repairTracking: ALOutboundRepairTrackingPlan | undefined;
    readonly supersedenceTracking: ALOutboundSupersedenceTrackingPlan | undefined;
}

export function toRtcOutboundTracking(
    effective: ALQosEffectivePolicy,
    msg: ALMessage,
    expectedPeerIds: readonly string[]
): RtcOutboundTracking {
    return {
        ackTracking: effective.ack.algo === 'none' ? undefined : {
            enabled: true,
            timeoutMs: effective.ack.opts.timeoutMs,
            maxAttempts: effective.retry.algo === 'none' ? 0 : effective.retry.opts.maxAttempts,
            expectedPeerIds: [...new Set(expectedPeerIds)]
        },
        retryTracking: effective.retry.algo === 'none' ? undefined : {
            enabled: true,
            maxAttempts: effective.retry.opts.maxAttempts
        },
        repairTracking: effective.repair.algo === 'none' ? undefined : {
            enabled: true,
            algo: effective.repair.algo,
            maxAttempts: effective.repair.opts.maxRepairs
        },
        supersedenceTracking: effective.supersedence.algo === 'none' ? undefined : {
            enabled: true,
            algo: effective.supersedence.algo,
            key: resolveSupersedenceKey(msg, effective),
            replacesMsgId: effective.supersedence.opts.replacesMsgId
        }
    };
}
