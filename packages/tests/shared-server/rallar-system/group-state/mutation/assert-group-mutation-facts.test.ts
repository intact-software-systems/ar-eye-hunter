import { describe, expect, it } from 'vitest';

import { assertGroupMutationFacts } from '@shared-server/rallar-system/group-state/mutation/state-validation/assert-group-mutation-facts.ts';

import { createGroupAuthorityFacts } from './group-mutation-test-runtime.ts';

describe('group mutation facts validation', () => {
    it('accepts an attempt at or after its ingress instant', () => {
        const facts = createGroupAuthorityFacts();

        expect(() => assertGroupMutationFacts(facts)).not.toThrow();
        expect(() => assertGroupMutationFacts({ ...facts, attemptAtEpochMs: facts.nowEpochMs + 1 })).not.toThrow();
    });

    it('rejects a non-string command hash whose string coercion matches the hash format', () => {
        const facts = createGroupAuthorityFacts();

        expect(() =>
            assertGroupMutationFacts({
                ...facts,
                // @ts-expect-error Malformed persisted facts must not pass through string coercion.
                commandHash: [facts.commandHash]
            })
        ).toThrow('Group mutation commandHash is invalid');
    });

    it('rejects an attempt dated before its ingress instant', () => {
        const facts = createGroupAuthorityFacts();

        expect(() => assertGroupMutationFacts({ ...facts, attemptAtEpochMs: facts.nowEpochMs - 1 }))
            .toThrow('Group mutation attempt timestamp is invalid');
    });

    it('rejects facts that carry no attempt instant', () => {
        const { attemptAtEpochMs: _attemptAtEpochMs, ...facts } = createGroupAuthorityFacts();

        // @ts-expect-error Persisted facts without the required attempt instant must be rejected.
        expect(() => assertGroupMutationFacts(facts))
            .toThrow('Group mutation attempt timestamp is invalid');
    });
});
