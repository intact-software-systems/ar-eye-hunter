import { describe, expect, it } from 'vitest';

import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';

import { createGroupAuthorityFacts } from './group-mutation-test-runtime.ts';

const {
    attemptCount: _attemptCount,
    attemptAtEpochMs: _attemptAtEpochMs,
    traceId: _traceId,
    ...INGRESS_FACTS
} = createGroupAuthorityFacts();
const TRACE_ID = 'trace-to-group-mutation-attempt-facts';

describe('group mutation attempt facts', () => {
    it('samples the lane instant when the lane runs after the ingress, and carries the queued envelope trace', () => {
        const facts = toGroupMutationAttemptFacts({
            ingressFacts: INGRESS_FACTS,
            attemptCount: 2,
            laneNowEpochMs: INGRESS_FACTS.nowEpochMs + 7_000,
            traceId: TRACE_ID
        });

        expect(facts).toEqual({
            ...INGRESS_FACTS,
            attemptCount: 2,
            attemptAtEpochMs: INGRESS_FACTS.nowEpochMs + 7_000,
            traceId: TRACE_ID
        });
    });

    it('holds the attempt at the ingress instant when the lane clock lags the enqueuing server', () => {
        const facts = toGroupMutationAttemptFacts({
            ingressFacts: INGRESS_FACTS,
            attemptCount: 1,
            laneNowEpochMs: INGRESS_FACTS.nowEpochMs - 250,
            traceId: TRACE_ID
        });

        expect(facts.attemptAtEpochMs).toBe(INGRESS_FACTS.nowEpochMs);
    });
});
