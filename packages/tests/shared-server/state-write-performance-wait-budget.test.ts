import { describe, expect, it } from 'vitest';

describe('API-v1 state-write benchmark AppInbox wait budget', () => {
  it('covers all retry delays and processing margin for both service runtimes', async () => {
    const benchmark = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts',
    ) as Record<string, unknown>;

    expect(benchmark.STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS).toEqual({
      client: {
        waitMaxElapsedMsecs: 421_240,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 5,
        waitJitterRatio: 0,
      },
      group: {
        waitMaxElapsedMsecs: 421_240,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 5,
        waitJitterRatio: 0,
      },
    });
  });
});
