import assert from 'node:assert/strict';

import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';

import { toApiAppInboxServiceOptions } from '../../src/services/timing-service.ts';

Deno.test('API app inbox options preserve every resolved wait policy field', () => {
    assert.deepEqual(
        toApiAppInboxServiceOptions({
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            retry: { maxAttempts: 9, maxDelayMs: 400, conflictMaxDelayMs: 75 },
            phaseTiming: true,
            newLaneConcurrency: 4,
            newLaneHeldRows: 16,
            completionWait: {
                maxElapsedMs: 45_000,
                retryIntervalMs: 125,
                maxRetryIntervalMs: 750,
                jitterRatio: 0.05
            }
        }),
        {
            conflictRetryMaxDelayMs: 75,
            phaseTiming: true,
            waitMaxElapsedMsecs: 45_000,
            waitRetryIntervalMsecs: 125,
            waitMaxRetryIntervalMsecs: 750,
            waitJitterRatio: 0.05
        }
    );
});
