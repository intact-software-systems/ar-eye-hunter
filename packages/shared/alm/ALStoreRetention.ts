export const DEFAULT_AL_EPHEMERAL_TTL_MS = 30 * 60_000;
export const DEFAULT_AL_REPOSITORY_TTL_MS = 60 * 60_000;

export type ALRuntimeStoreRetentionConfig = Readonly<{
    ephemeralTtlMs?: number;
    repositoryTtlMs?: number;
    versionTtlMs?: number;
    msgOwnerTtlMs?: number;
    controlHistoryTtlMs?: number;
    controlPendingTtlMs?: number;
    durableEffectTtlMs?: number;
    repairAttemptTtlMs?: number;
    sentMessageTtlMs?: number;
    bufferedMessageTtlMs?: number;
}>;

export type NormalizedALRuntimeStoreRetentionConfig = Readonly<{
    ephemeralTtlMs: number;
    repositoryTtlMs: number;
    versionTtlMs: number;
    msgOwnerTtlMs: number;
    controlHistoryTtlMs: number;
    controlPendingTtlMs: number;
    durableEffectTtlMs: number;
    repairAttemptTtlMs: number;
    sentMessageTtlMs: number;
    bufferedMessageTtlMs: number;
}>;

export function normalizeALRuntimeStoreRetention(
    config?: ALRuntimeStoreRetentionConfig
): NormalizedALRuntimeStoreRetentionConfig {
    const ephemeralTtlMs = normalizeTtlMs(config?.ephemeralTtlMs ?? DEFAULT_AL_EPHEMERAL_TTL_MS);
    const repositoryTtlMs = normalizeTtlMs(config?.repositoryTtlMs ?? DEFAULT_AL_REPOSITORY_TTL_MS);

    return {
        ephemeralTtlMs,
        repositoryTtlMs,
        versionTtlMs: normalizeTtlMs(config?.versionTtlMs ?? repositoryTtlMs),
        msgOwnerTtlMs: normalizeTtlMs(config?.msgOwnerTtlMs ?? repositoryTtlMs),
        controlHistoryTtlMs: normalizeTtlMs(config?.controlHistoryTtlMs ?? ephemeralTtlMs),
        controlPendingTtlMs: normalizeTtlMs(config?.controlPendingTtlMs ?? ephemeralTtlMs),
        durableEffectTtlMs: normalizeTtlMs(config?.durableEffectTtlMs ?? ephemeralTtlMs),
        repairAttemptTtlMs: normalizeTtlMs(config?.repairAttemptTtlMs ?? ephemeralTtlMs),
        sentMessageTtlMs: normalizeTtlMs(config?.sentMessageTtlMs ?? repositoryTtlMs),
        bufferedMessageTtlMs: normalizeTtlMs(config?.bufferedMessageTtlMs ?? repositoryTtlMs)
    };
}

export function toExpireAtTimestampFromNow(
    ttlMs: number,
    nowMs = Date.now()
): number {
    return nowMs + normalizeTtlMs(ttlMs);
}

export function resolveExpireAtTimestampWithFallback(
    expireAtTimestamp: number | undefined,
    fallbackTtlMs: number,
    nowMs = Date.now()
): number {
    return expireAtTimestamp ?? toExpireAtTimestampFromNow(fallbackTtlMs, nowMs);
}

function normalizeTtlMs(ttlMs: number): number {
    return Math.max(0, ttlMs);
}
