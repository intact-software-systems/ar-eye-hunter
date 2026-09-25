import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
import type { ALQosEffectivePolicy } from '../../al-contracts/al-policy.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundMessageRuntime
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from '../../alm/outbound/control/al-outbound-control-admission.ts';

/**
 * The receipt a WS send tracks. A unicast expects its addressee as its hop (`receiver` on a WS
 * unicast is refused at admission); a `receiver` room send expects nobody yet, because the server's
 * `admitted` receipt names the frozen audience the row is created from. Any other room send tracks
 * no receipt on WS.
 */
export function toWsQueueBoxClientAckTrackingPlan(
    effective: ALQosEffectivePolicy,
    msg: ALMessage
): ALOutboundAckTrackingPlan | undefined {
    const receiptAudience = toReceiptAudience(effective, msg.targets);
    if (effective.ack.algo === 'none' || receiptAudience === undefined) {
        return undefined;
    }
    return {
        enabled: true,
        timeoutMs: effective.ack.opts.timeoutMs,
        maxAttempts: effective.retry.algo === 'none' ? 0 : effective.retry.opts.maxAttempts,
        expectedPeerIds: receiptAudience,
        mode: effective.ack.algo
    };
}

function toReceiptAudience(
    effective: ALQosEffectivePolicy,
    targets: ALMessage['targets']
): readonly string[] | undefined {
    if (targets?.mode === 'unicast') {
        return [targets.toPeerId];
    }
    return effective.ack.algo === 'receiver' && targets !== undefined ? [] : undefined;
}

/**
 * A control the WS client admitted from its server: a receipt moves the origin's receipt row, every
 * other control goes to the outbound owner's control admission. Only the trusted server reaches here
 * with a receipt; ingress validation refused it from any other source.
 */
export async function acceptWsQueueBoxClientControlMessage<TPrepared>(
    outboundRuntime: ALOutboundMessageRuntime<TPrepared>,
    msg: ALMessage
): Promise<ALOutboundControlAdmissionResult> {
    const control = decodeALControlMessage(msg).right;
    return control?.type === 'receipt'
        ? await outboundRuntime.acceptReceipt(control.payload)
        : await outboundRuntime.acceptControlMessage(msg);
}
