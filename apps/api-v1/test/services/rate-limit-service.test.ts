import { readRateLimiter, readRequestClientKey } from '@shared-server/http/rate-limit-service.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import { test } from 'bun:test';
import assert from 'node:assert/strict';

test('readRateLimiter caches a limiter by namespace, key, and policy', async () => {
    const namespace = `test-${crypto.randomUUID()}`;
    const policy = new RateLimiterPolicy(60_000, 2);

    const limiter = readRateLimiter(namespace, 'client-1', policy);
    assert.equal(readRateLimiter(namespace, 'client-1', policy), limiter);

    assert.equal(
        await RateLimiter.tryToExecuteOrDefault(
            limiter,
            () => Promise.resolve(true),
            false
        ),
        true
    );
    assert.equal(
        await RateLimiter.tryToExecuteOrDefault(
            limiter,
            () => Promise.resolve(true),
            false
        ),
        true
    );
    assert.equal(
        await RateLimiter.tryToExecuteOrDefault(
            limiter,
            () => Promise.resolve(true),
            false
        ),
        false
    );
});

test('readRateLimiter separates limits by policy', () => {
    const namespace = `test-${crypto.randomUUID()}`;
    const first = readRateLimiter(
        namespace,
        'client-1',
        new RateLimiterPolicy(60_000, 2)
    );
    const second = readRateLimiter(
        namespace,
        'client-1',
        new RateLimiterPolicy(60_000, 3)
    );

    assert.notEqual(second, first);
});

test('readRateLimiter keeps keys that differ only past 160 characters apart', () => {
    const namespace = `test-${crypto.randomUUID()}`;
    const policy = new RateLimiterPolicy(60_000, 2);
    const sharedPrefix = 'x'.repeat(200);

    const first = readRateLimiter(namespace, `${sharedPrefix}:principal-a`, policy);
    const second = readRateLimiter(namespace, `${sharedPrefix}:principal-b`, policy);

    assert.notEqual(second, first);
    assert.equal(readRateLimiter(namespace, `${sharedPrefix}:principal-a`, policy), first);
});

test('readRateLimiter still treats keys as trimmed and case-insensitive', () => {
    const namespace = `test-${crypto.randomUUID()}`;
    const policy = new RateLimiterPolicy(60_000, 2);

    const limiter = readRateLimiter(namespace, 'client-1', policy);

    assert.equal(readRateLimiter(namespace, '  Client-1 ', policy), limiter);
    assert.equal(readRateLimiter(namespace, '   ', policy), readRateLimiter(namespace, 'unknown', policy));
});

test('a spent hourly room creation allowance survives idle time until its refill boundary', () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
        const appId = crypto.randomUUID();
        const policy = new RateLimiterPolicy(3_600_000, 1);
        const create = () => readRateLimiter('temporary-room-creation', appId, policy).allow();
        assert.equal(create(), true);
        now += 660_000;
        assert.equal(create(), false);
        now = 0;
        assert.equal(create(), false);
        now = 3_600_999;
        assert.equal(create(), false);
        now++;
        assert.equal(create(), true);
    }
    finally {
        Date.now = originalNow;
    }
});

test('readRateLimiter replaces an expired cached limiter for the same key', () => {
    const originalNow = Date.now;
    let nowMs = 1_000;
    Date.now = () => nowMs;
    try {
        const namespace = `test-${crypto.randomUUID()}`;
        const policy = new RateLimiterPolicy(60_000, 2);

        const first = readRateLimiter(namespace, 'client-1', policy);
        nowMs += 10 * 60_000 + 1;
        const second = readRateLimiter(namespace, 'client-1', policy);

        assert.notEqual(second, first);
        assert.equal(readRateLimiter(namespace, 'client-1', policy), second);
    }
    finally {
        Date.now = originalNow;
    }
});

test('readRequestClientKey prefers proxy client headers', () => {
    const req = {
        header(name: string): string | undefined {
            switch (name) {
                case 'cf-connecting-ip':
                    return undefined;
                case 'x-real-ip':
                    return undefined;
                case 'x-forwarded-for':
                    return '203.0.113.10, 10.0.0.1';
                default:
                    return undefined;
            }
        }
    };

    assert.equal(readRequestClientKey(req), '203.0.113.10');
});

test('readRequestClientKey bounds an untrusted forwarded value to 256 characters', () => {
    const forwarded = `for=${'a'.repeat(1_000)}`;
    const req = {
        header(name: string): string | undefined {
            return name === 'forwarded' ? forwarded : undefined;
        }
    };

    assert.equal(readRequestClientKey(req), forwarded.slice(0, 256));
});
