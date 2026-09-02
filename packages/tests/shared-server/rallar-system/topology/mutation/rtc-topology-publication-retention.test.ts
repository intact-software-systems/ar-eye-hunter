import { describe, expect, it } from 'vitest';

import {
    computeTopologyMutation,
    validateTopologyMutation,
    type RtcTopologyMutationInput
} from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { toStoredRtcTopologySnapshotRow } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createRtcTopologyReplayFixture } from '../replay/consumer/rtc-topology-replay-fixture.ts';

describe('topology publication retention', () => {
    it.each(['write', 'publish-superseded'] as const)(
        'rejects premature publication expiry before producing a %s persistence result',
        (outcome) => {
            const input = publicationInput(outcome, 86_400_999);

            expect(() => computeTopologyMutation(input)).toThrow(/retention|expiry/i);
        }
    );

    it.each(['write', 'publish-superseded'] as const)(
        'keeps %s publication and receipt rows alive for at least the delivery lifetime',
        (outcome) => {
            for (const publicationExpireAtTimestamp of [86_401_000, 86_402_000]) {
                const input = publicationInput(outcome, publicationExpireAtTimestamp);
                const computed = computeTopologyMutation(input);
                validateTopologyMutation({ ...input, computed });
                expect(computed.outcome).toBe(outcome);
                if (computed.outcome !== 'write' && computed.outcome !== 'publish-superseded') {
                    throw new Error('Expected publication persistence');
                }
                expect(computed.persistence.publication?.expireAtIsoTimestamp).toBe(
                    new Date(publicationExpireAtTimestamp).toISOString()
                );
                expect(computed.publicationDelivery?.outboxWrite.entry.audit.expiryTs.epochMilliseconds).toBe(86_401_000);
                expect(computed.publicationDelivery?.appendInput?.retainUntilEpochMs).toBe(86_401_000);
            }
        }
    );
});

function publicationInput(
    outcome: 'write' | 'publish-superseded',
    publicationExpireAtTimestamp: number
): RtcTopologyMutationInput {
    const { publication, currentSnapshot } = createRtcTopologyReplayFixture();
    const newerSnapshot = {
        ...currentSnapshot,
        sourceGroupStateCausalRevision: { groupRevision: 5, presenceRevision: 7 },
        version: 9
    };
    return {
        read: {
            snapshot: outcome === 'write' ? null : {
                entry: {
                    ...toStoredRtcTopologySnapshotRow(newerSnapshot),
                    revision: 7,
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                    updatedTimestamp: '1970-01-01T00:00:01.000Z'
                },
                value: newerSnapshot
            },
            publicationClaim: null
        },
        candidate: currentSnapshot,
        publication,
        deliveryPublisherStreamId: '00000000-0000-4000-8000-000000000001',
        facts: {
            publicationExpireAtTimestamp,
            commandHash: `sha256:${'a'.repeat(64)}`,
            attemptCount: 1
        }
    };
}
