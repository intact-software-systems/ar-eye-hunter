import assert from 'node:assert/strict';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/Resilience.ts';
import { readRateLimiter, readRequestClientKey } from '@shared-server/http/rate-limit-service.ts';

Deno.test('readRateLimiter caches a limiter by namespace, key, and policy', async () => {
  const namespace = `test-${crypto.randomUUID()}`;
  const policy = new RateLimiterPolicy(60_000, 2);

  const limiter = readRateLimiter(namespace, 'client-1', policy);
  assert.equal(readRateLimiter(namespace, 'client-1', policy), limiter);

  assert.equal(
    await RateLimiter.tryToExecuteOrDefault(
      limiter,
      () => Promise.resolve(true),
      false,
    ),
    true,
  );
  assert.equal(
    await RateLimiter.tryToExecuteOrDefault(
      limiter,
      () => Promise.resolve(true),
      false,
    ),
    true,
  );
  assert.equal(
    await RateLimiter.tryToExecuteOrDefault(
      limiter,
      () => Promise.resolve(true),
      false,
    ),
    false,
  );
});

Deno.test('readRateLimiter separates limits by policy', () => {
  const namespace = `test-${crypto.randomUUID()}`;
  const first = readRateLimiter(
    namespace,
    'client-1',
    new RateLimiterPolicy(60_000, 2),
  );
  const second = readRateLimiter(
    namespace,
    'client-1',
    new RateLimiterPolicy(60_000, 3),
  );

  assert.notEqual(second, first);
});

Deno.test('readRequestClientKey prefers proxy client headers', () => {
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
    },
  };

  assert.equal(readRequestClientKey(req), '203.0.113.10');
});
