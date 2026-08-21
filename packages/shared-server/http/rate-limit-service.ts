import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RateLimiter, RateLimiterPolicy, SlidingWindowCounter } from '@shared/resilience/Resilience.ts';

const RATE_LIMITER_CACHE_TTL_MS = 10 * 60_000;
const RATE_LIMITER_CACHE_DELETE_EXPIRED_INTERVAL_MS = 60_000;
const UNKNOWN_CLIENT_KEY = 'unknown';

type HeaderReader = Readonly<{
    header(name: string): string | undefined;
}>;

const rateLimiters = new LatestRepository<string, RateLimiter>({
    ttlMs: RATE_LIMITER_CACHE_TTL_MS,
    deleteExpiredIntervalMs: RATE_LIMITER_CACHE_DELETE_EXPIRED_INTERVAL_MS
});

export function readRateLimiter(
    namespace: string,
    key: string,
    policy: RateLimiterPolicy
): RateLimiter {
    const limiterKey = toLimiterKey(namespace, key, policy);
    const limiter = rateLimiters.setIfAbsent(
        limiterKey,
        () => createRateLimiter(policy)
    );
    rateLimiters.touch(limiterKey);

    return limiter;
}

export function readRequestClientKey(req: HeaderReader): string {
    return readForwardedHeader(req, 'cf-connecting-ip') ??
        readForwardedHeader(req, 'x-real-ip') ??
        readForwardedHeader(req, 'x-forwarded-for') ??
        readForwardedHeader(req, 'forwarded') ??
        UNKNOWN_CLIENT_KEY;
}

function createRateLimiter(policy: RateLimiterPolicy): RateLimiter {
    return new RateLimiter(
        SlidingWindowCounter.init(
            policy.timebasedFilterMs,
            Math.floor(policy.timebasedFilterMs / 4)
        ),
        policy
    );
}

function toLimiterKey(
    namespace: string,
    key: string,
    policy: RateLimiterPolicy
): string {
    return [
        normaliseKey(namespace),
        policy.timebasedFilterMs,
        policy.maxNumberToAllow,
        normaliseKey(key)
    ].join(':');
}

function readForwardedHeader(
    req: HeaderReader,
    headerName: string
): string | undefined {
    const raw = req.header(headerName);
    if (!raw) {
        return undefined;
    }

    const value = raw.split(',')[0]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function normaliseKey(key: string): string {
    const trimmed = key.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed.slice(0, 160) : UNKNOWN_CLIENT_KEY;
}
