import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs, type ALQosEffectivePolicy } from '../../al-contracts/al-policy.ts';

export const AL_OUTBOUND_MESSAGE_LIFETIME_MS = 30_000;

/**
 * Captures selected expiry before transport copies are prepared; replay keeps the envelope bound. A message that
 * carries a publication proof was normalized before it was signed, so it is returned as it is.
 */
export function toALOutboundMessage(msg: ALMessage, effective: ALQosEffectivePolicy): ALMessage {
    if (msg.proof !== undefined) {
        return msg;
    }
    const expiresAtMs = resolveALMessageExpireAtMs(msg, effective) ??
        (msg.audit?.createdTs ?? msg.id.ts) + AL_OUTBOUND_MESSAGE_LIFETIME_MS;
    return {
        ...msg,
        qos: { ...msg.qos, expiry: effective.expiry },
        constraints: { ...msg.constraints, expiresAtMs }
    };
}
