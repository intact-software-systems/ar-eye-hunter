import { expect, it, vi } from 'vitest';

import { settleALOutboundClaim } from '@shared/alm/outbound/lane/settle-al-outbound-claim.ts';
import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';

const CLAIM = {
    entry: toResourceEntryWithKey({ topicId: 'AL_OUTBOUND', resourceId: 'ns', contextId: 'effect' }, 'AL_OUTBOUND', {}),
    attempts: 1,
    leaseUntilMs: 30_000
};

it.each([
    { timed: false, clockReads: 0, run: undefined },
    { timed: true, clockReads: 2, run: { payloadKind: 'send-prepared', durationMs: 6 } }
])('reads the clock $clockReads times for a claim whose timing is wanted: $timed', async ({ timed, clockReads, run }) => {
    let nowMs = 1_000;
    const readNowMs = vi.fn(() => {
        nowMs += 6;
        return nowMs;
    });

    const settled = await settleALOutboundClaim({
        attempt: Promise.resolve({ status: 'completed' }),
        observed: { evidence: undefined, payloadKind: 'send-prepared' },
        claim: CLAIM,
        batchIndex: 0,
        capture: undefined,
        readNowMs,
        timed
    });

    expect(settled).toEqual({ outcome: { status: 'completed' }, run });
    // The clock read is itself the requirement: a lane with no diagnostics sink pays for no timing.
    expect(readNowMs).toHaveBeenCalledTimes(clockReads);
});
