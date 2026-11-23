import { expect, it } from 'vitest';

import { settleALOutboundClaim } from '@shared/alm/outbound/lane/settle-al-outbound-claim.ts';
import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';

const CLAIM = {
    entry: toResourceEntryWithKey({ topicId: 'AL_OUTBOUND', resourceId: 'ns', contextId: 'effect' }, 'AL_OUTBOUND', {}),
    attempts: 1,
    leaseUntilMs: 30_000
};

it.each([
    { timed: false, clockReadCount: 0, runs: [] },
    {
        timed: true,
        clockReadCount: 2,
        runs: [{ payloadKind: 'send-prepared', effectId: 'effect-1', expedited: true, run: 2, durationMs: 6 }]
    }
])('reads the clock $clockReadCount times for a claim whose timing is wanted: $timed', async ({ timed, clockReadCount, runs }) => {
    // The clock read is itself the requirement: a lane with no diagnostics sink pays for no timing.
    const clockReads: number[] = [];
    const readNowMs = () => {
        clockReads.push(1_000 + 6 * (clockReads.length + 1));
        return clockReads.at(-1)!;
    };

    const settled = await settleALOutboundClaim({
        attempt: Promise.resolve({ status: 'completed' }),
        observed: { evidence: undefined, work: { effectId: 'effect-1', payloadKind: 'send-prepared' } },
        claim: CLAIM,
        claimRun: { expedited: true, run: 2 },
        batchIndex: 0,
        capture: undefined,
        readNowMs,
        timed
    });

    expect(settled).toEqual({ outcome: { status: 'completed' }, runs });
    expect(clockReads).toHaveLength(clockReadCount);
});
