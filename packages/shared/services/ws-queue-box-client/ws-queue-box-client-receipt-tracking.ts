import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
import type { ALQosEffectivePolicy } from '../../al-contracts/al-policy.ts';
import { isALUnicastAddressedTo } from '../../al-contracts/is-al-unicast-addressed-to.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundMessageRuntime
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from '../../alm/outbound/control/al-outbound-control-admission.ts';

/**
 * The receipt a WS send tracks. The server is the one hop a WS origin has (R-S3a-4): a unicast addressed to the server
 * and every `hop` or `subtree` send expect the server's own ACK. A `receiver` send to a session or a room expects
 * nobody yet: the server's `admitted` receipt names the frozen audience the row is created from (D53). With no server
 * id known (a server that predates S3c-i), a send tracks what it did before: a unicast its addressee, a room send
 * nothing unless it asks `receiver`.
 */
export function toWsQueueBoxClientAckTrackingPlan(
    effective: ALQosEffectivePolicy,
    msg: ALMessage,
    serverPeerId: string | undefined
): ALOutboundAckTrackingPlan | undefined {
    const receiptAudience = toReceiptAudience(effective, msg, serverPeerId);
    if (effective.ack.algo === 'none' || receiptAudience === undefined) {
        return undefined;
    }
    return {
        enabled: true,
        timeoutMs: effective.ack.opts.timeoutMs,
        maxAttempts: effective.retry.algo === 'none' ? 0 : effective.retry.opts.maxAttempts,
        expectedPeerIds: receiptAudience,
        nextHopPeerIds: receiptAudience,
        mode: effective.ack.algo
    };
}

function toReceiptAudience(
    effective: ALQosEffectivePolicy,
    msg: ALMessage,
    serverPeerId: string | undefined
): readonly string[] | undefined {
    const targets = msg.targets;
    if (targets === undefined) {
        return undefined;
    }
    if (serverPeerId === undefined) {
        return toServerUnknownReceiptAudience(effective, targets);
    }
    return isALUnicastAddressedTo(msg, serverPeerId) || effective.ack.algo !== 'receiver'
        ? [serverPeerId]
        : [];
}

function toServerUnknownReceiptAudience(
    effective: ALQosEffectivePolicy,
    targets: NonNullable<ALMessage['targets']>
): readonly string[] | undefined {
    if (targets.mode === 'unicast') {
        return effective.ack.algo === 'receiver' ? [] : [targets.toPeerId];
    }
    return effective.ack.algo === 'receiver' ? [] : undefined;
}

/**
 * A control the WS client admitted from its server: a receipt moves the receipt row of the origin, and
 * every other control goes to control admission as the word of the trusted server. The WS server never
 * relays a peer NACK, so a NACK here is the verdict of the server itself as the relay.
 */
export async function acceptWsQueueBoxClientControlMessage<TPrepared>(
    outboundRuntime: ALOutboundMessageRuntime<TPrepared>,
    msg: ALMessage
): Promise<ALOutboundControlAdmissionResult> {
    const control = decodeALControlMessage(msg).right;
    return control?.type === 'receipt'
        ? await outboundRuntime.acceptReceipt(msg)
        : await outboundRuntime.acceptControlMessage(msg, 'trusted-server');
}
