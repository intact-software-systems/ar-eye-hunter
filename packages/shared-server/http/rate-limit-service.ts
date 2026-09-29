import { createHash } from 'node:crypto';

import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RateLimiter, RateLimiterPolicy, SlidingWindowCounter } from '@shared/resilience/Resilience.ts';

const RATE_LIMITER_CACHE_TTL_MS = 10 * 60_000;
const RATE_LIMITER_CACHE_DELETE_EXPIRED_INTERVAL_MS = 60_000;
const UNKNOWN_CLIENT_KEY = 'unknown';
const MAX_LIMITER_KEY_LENGTH = 160;
const HASHED_KEY_READABLE_PREFIX_LENGTH = 64;

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

export function readRequestClientKey(request: HeaderReader): string {
    return readForwardedHeader(request, 'cf-connecting-ip') ??
        readForwardedHeader(request, 'x-real-ip') ??
        readForwardedHeader(request, 'x-forwarded-for') ??
        readForwardedHeader(request, 'forwarded') ??
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
    return value && value.length > 0 ? value : undefined;
}

function toNormalisedKey(key: string): string {
    const trimmed = key.trim().toLowerCase();
    if (trimmed.length === 0) {
        return UNKNOWN_CLIENT_KEY;
    }
    if (trimmed.length <= MAX_LIMITER_KEY_LENGTH) {
        return trimmed;
    }

    const digest = createHash('sha256').update(trimmed).digest('hex');
    return `${trimmed.slice(0, HASHED_KEY_READABLE_PREFIX_LENGTH)}~${digest}`;
}
