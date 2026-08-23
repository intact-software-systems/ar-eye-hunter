import assert from 'node:assert/strict';
import { toApiAppInboxServiceOptions } from '../../src/services/timing-service.ts';

Deno.test('API app inbox options preserve every resolved wait policy field', () => {
    assert.deepEqual(
        toApiAppInboxServiceOptions({
            phaseTiming: true,
            completionWait: {
                maxElapsedMs: 45_000,
                retryIntervalMs: 125,
                maxRetryIntervalMs: 750,
                jitterRatio: 0.05
            }
        }),
        {
            phaseTiming: true,
            waitMaxElapsedMsecs: 45_000,
            waitRetryIntervalMsecs: 125,
            waitMaxRetryIntervalMsecs: 750,
            waitJitterRatio: 0.05
        }
    );
});
