import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs, type ALQosEffectivePolicy } from '../../al-contracts/al-policy.ts';

export const AL_OUTBOUND_MESSAGE_LIFETIME_MS = 30_000;

/** Captures selected expiry before transport copies are prepared; replay keeps the envelope bound. */
export function toALOutboundMessage(msg: ALMessage, effective: ALQosEffectivePolicy): ALMessage {
    const expiresAtMs = resolveALMessageExpireAtMs(msg, effective) ??
        (msg.audit?.createdTs ?? msg.id.ts) + AL_OUTBOUND_MESSAGE_LIFETIME_MS;
    return {
        ...msg,
        qos: { ...msg.qos, expiry: effective.expiry },
        constraints: { ...msg.constraints, expiresAtMs }
    };
}
