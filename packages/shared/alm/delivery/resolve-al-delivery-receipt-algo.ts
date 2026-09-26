import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { normalizeALQosPolicy, type ALAckAlgo } from '../../al-contracts/al-policy.ts';

/**
 * The receipt a handle waits for, read from the envelope's effective policy rather than its
 * `delivery.ack` alone, so a receipt requested only through `qos.ack` keeps the handle open.
 * It is the request normalized with default capabilities; the receipt the admitting carrier
 * tracks replaces it at admission (R-S3a-4).
 */
export function resolveALDeliveryReceiptAlgo(message: ALMessage): ALAckAlgo {
    return normalizeALQosPolicy(message).effective.ack.algo;
}
