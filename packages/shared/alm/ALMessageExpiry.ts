import type { ALMessage } from '../al-contracts/al-contract.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';

export function resolveExplicitOutboundMessageExpireAtMs(
    msg: ALMessage,
): number | undefined {
    return msg.constraints?.expiresAtMs
        ?? msg.qos?.expiry?.opts?.expiresAtMs;
}

export function resolveOutboundMessageExpireAtMs(
    msg: ALMessage,
    fallbackExpireAtTimestamp: number = NEVER_EXPIRE_AT_TIMESTAMP,
): number {
    return resolveExplicitOutboundMessageExpireAtMs(msg) ?? fallbackExpireAtTimestamp;
}
