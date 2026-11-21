import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALOutboundSupersedenceTrackingPlan } from '../al-outbound-message-runtime.ts';

/**
 * The send with the latest-wins supersedence its plan applied written into its own `qos` request, so every receiver
 * plans it as if the app had asked for it: only the sender's QoS provider knows a default. A requested supersedence
 * stays as asked, a signed send keeps its signed fields, and any other send is returned as it is, the same object.
 */
export function toALMessageWithAppliedSupersedence(
    msg: ALMessage,
    tracking: ALOutboundSupersedenceTrackingPlan | undefined
): ALMessage {
    if (
        msg.proof !== undefined || msg.qos?.supersedence !== undefined || tracking?.enabled !== true ||
        tracking.algo !== 'latest-wins' || tracking.key === undefined
    ) {
        return msg;
    }
    const opts = tracking.replacesMsgId === undefined
        ? { supersedenceKey: tracking.key }
        : { supersedenceKey: tracking.key, replacesMsgId: tracking.replacesMsgId };
    return { ...msg, qos: { ...msg.qos, supersedence: { algo: tracking.algo, opts } } };
}
