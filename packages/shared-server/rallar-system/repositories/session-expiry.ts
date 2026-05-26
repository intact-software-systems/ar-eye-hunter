import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

export const STATE_SESSION_PURGE_GRACE_MSECS = 24 * 60 * 60 * 1000;

export function toSessionPurgeAfterEpochMs(
    expiresAtEpochMs: number,
    disconnectedAtEpochMs?: number,
): number {
    const logicalExpiry = Math.max(expiresAtEpochMs, disconnectedAtEpochMs ?? 0);

    if (
        logicalExpiry >=
        NEVER_EXPIRE_AT_TIMESTAMP - STATE_SESSION_PURGE_GRACE_MSECS
    ) {
        return NEVER_EXPIRE_AT_TIMESTAMP;
    }

    return logicalExpiry + STATE_SESSION_PURGE_GRACE_MSECS;
}

export function isLogicallyActiveSession(
    expiresAtEpochMs: number,
    timestamp: number = Date.now(),
): boolean {
    return expiresAtEpochMs > timestamp;
}
