import { describe, expect, it } from 'vitest';

import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';

import { createGroupAuthorityFacts } from './group-mutation-test-runtime.ts';

const { attemptCount: _attemptCount, attemptAtEpochMs: _attemptAtEpochMs, ...INGRESS_FACTS } = createGroupAuthorityFacts();

describe('group mutation attempt facts', () => {
    it('samples the lane instant when the lane runs after the ingress', () => {
        const facts = toGroupMutationAttemptFacts(INGRESS_FACTS, 2, INGRESS_FACTS.nowEpochMs + 7_000);

        expect(facts).toEqual({ ...INGRESS_FACTS, attemptCount: 2, attemptAtEpochMs: INGRESS_FACTS.nowEpochMs + 7_000 });
    });

    it('holds the attempt at the ingress instant when the lane clock lags the enqueuing server', () => {
        const facts = toGroupMutationAttemptFacts(INGRESS_FACTS, 1, INGRESS_FACTS.nowEpochMs - 250);

        expect(facts.attemptAtEpochMs).toBe(INGRESS_FACTS.nowEpochMs);
    });
});
