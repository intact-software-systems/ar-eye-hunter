import { describe, expect, it } from 'vitest';

import { STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS } from '../../../scripts/perf/state-write-wait-options.ts';

describe('API-v1 state-write benchmark AppInbox wait budget', () => {
    it('covers all retry delays and processing margin for both service runtimes', () => {
        expect(STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS).toEqual({
            client: {
                waitMaxElapsedMsecs: 421_240,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 5,
                waitJitterRatio: 0
            },
            group: {
                waitMaxElapsedMsecs: 421_240,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 5,
                waitJitterRatio: 0
            }
        });
    });
});
