import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALOutboundSupersedenceTrackingPlan } from './al-outbound-message-runtime.ts';

/**
 * The send with the supersedence its plan applied written into its own `qos` request, so every receiver plans it as if
 * the app had asked for it: only the sender's QoS provider knows a default. A requested supersedence stays as asked,
 * and a send its plan supersedes nothing is returned as it is, the same object.
 */
export function toALMessageWithAppliedSupersedence(
    msg: ALMessage,
    tracking: ALOutboundSupersedenceTrackingPlan | undefined
): ALMessage {
    if (msg.qos?.supersedence !== undefined || tracking?.enabled !== true || tracking.key === undefined) {
        return msg;
    }
    const opts = tracking.replacesMsgId === undefined
        ? { supersedenceKey: tracking.key }
        : { supersedenceKey: tracking.key, replacesMsgId: tracking.replacesMsgId };
    return { ...msg, qos: { ...msg.qos, supersedence: { algo: tracking.algo, opts } } };
}
