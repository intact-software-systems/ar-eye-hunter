import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';

const MINIMUM_RATE_LIMITER_RETENTION_MS = 10 * 60_000;
const RATE_LIMITER_CACHE_DELETE_EXPIRED_INTERVAL_MS = 60_000;
const UNKNOWN_CLIENT_KEY = 'unknown';
const MAX_FORWARDED_CLIENT_KEY_LENGTH = 256;

type HeaderReader = Readonly<{
    header(name: string): string | undefined;
}>;

const rateLimiters = new LatestRepository<string, RateLimiter>({
    deleteExpiredIntervalMs: RATE_LIMITER_CACHE_DELETE_EXPIRED_INTERVAL_MS
});

export function readRateLimiter(
    namespace: string,
    key: string,
    policy: RateLimiterPolicy
): RateLimiter {
    const limiterKey = toLimiterKey(namespace, key, policy);
    const nowEpochMs = Date.now();
    const entry = rateLimiters.latest(limiterKey);
    const limiter = entry.readAt(nowEpochMs) ?? new RateLimiter(policy, nowEpochMs);
    const retentionMs = Math.max(MINIMUM_RATE_LIMITER_RETENTION_MS, policy.timebasedFilterMs);
    const expiresAt = Math.max(entry.readExpiresAtEpochMs() ?? 0, nowEpochMs + retentionMs);
    entry.acceptAt(limiter, nowEpochMs, expiresAt);

    return limiter;
}

export function readRequestClientKey(request: HeaderReader): string {
    return readForwardedHeader(request, 'cf-connecting-ip') ??
        readForwardedHeader(request, 'x-real-ip') ??
        readForwardedHeader(request, 'x-forwarded-for') ??
        readForwardedHeader(request, 'forwarded') ??
        UNKNOWN_CLIENT_KEY;
}

function toLimiterKey(
    namespace: string,
    key: string,
    policy: RateLimiterPolicy
): string {
    return [
        toNormalisedKey(namespace),
        policy.timebasedFilterMs,
        policy.maxNumberToAllow,
        toNormalisedKey(key)
    ].join(':');
}

function readForwardedHeader(
    request: HeaderReader,
    headerName: string
): string | undefined {
    const raw = request.header(headerName);
    if (!raw) {
        return undefined;
    }

    const value = raw.split(',')[0]?.trim();
    return value && value.length > 0 ? value.slice(0, MAX_FORWARDED_CLIENT_KEY_LENGTH) : undefined;
}

function toNormalisedKey(key: string): string {
    const trimmed = key.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : UNKNOWN_CLIENT_KEY;
}
