import { computeTopologyMutation, validateTopologyMutation } from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { describe, expect, it } from 'vitest';

import { createGroupRef, createPublication, createTopologySnapshot } from '../rtc-topology-repository-test-fixtures.ts';

describe('stale RTC topology publication', () => {
    it('persists an immutable older publication without regressing the latest snapshot', () => {
        const ref = createGroupRef();
        const candidate = createTopologySnapshot(ref, 3);
        const current = createTopologySnapshot(ref, 4);
        const base = createPublication(candidate, 'work-3');
        const publication = {
            ...base,
            message: { ...base.message, constraints: { expiresAtMs: 20_000 } }
        };
        const input = {
            read: {
                snapshot: {
                    entry: {
                        key: 'snapshot',
                        value: JSON.stringify(current),
                        expireAtTimestamp: 10_000,
                        updatedTimestamp: 'now',
                        revision: 7
                    },
                    value: current
                },
                publicationClaim: null
            },
            candidate,
            publication,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: publication.message.constraints.expiresAtMs,
                commandHash: `sha256:${'a'.repeat(64)}`,
                attemptCount: 1
            }
        } as const;

        const computed = computeTopologyMutation(input);

        expect(computed).toMatchObject({
            outcome: 'publish-superseded',
            currentGuard: { expectedRevision: 7, current },
            publication
        });
        expect(() => validateTopologyMutation({ ...input, computed })).not.toThrow();
    });
});
