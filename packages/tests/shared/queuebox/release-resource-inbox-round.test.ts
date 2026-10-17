import { describe, expect, it } from 'vitest';

import { ResourceInboxLostReservationError, type ResourceInboxRelease } from '@shared/queuebox/queue-box-types.ts';
import {
    releaseResourceInboxRound,
    type ResourceInboxRoundReleaser
} from '@shared/queuebox/resource-inbox/release-resource-inbox-round.ts';
import { EntityStatus, toResourceEntry, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

describe('releaseResourceInboxRound', () => {
    // A RETRY round can be the lane's whole retry quota, against a pool of five connections.
    it('releases the rows of a lost round alone, at most two at a time, and returns the lost one as a value', async () => {
        const entries = Array.from({ length: 6 }, (_value, index) => toResourceEntry(`row-${index}`, { index }));
        const lostKey = entries[2]!.key;
        let inFlight = 0;
        let maxInFlight = 0;
        const repository: ResourceInboxRoundReleaser = {
            releaseEntries: async (releases: readonly ResourceInboxRelease[]) => {
                if (releases.length > 1) {
                    throw new ResourceInboxLostReservationError(lostKey, 1);
                }
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 2));
                inFlight -= 1;
                const { entry } = releases[0]!;
                if (entry.key === lostKey) {
                    throw new ResourceInboxLostReservationError(lostKey, 1);
                }
                return new Map<ResourceEntry['key'], ResourceEntry>([[entry.key, entry]]);
            }
        };

        const round = await releaseResourceInboxRound(
            repository,
            entries.map((entry): ResourceInboxRelease => ({ entry, disposition: { status: EntityStatus.COMPLETED, delayMs: null } }))
        );

        expect(maxInFlight).toBe(2);
        expect(round.released.size).toBe(5);
        expect(round.lost).toBeInstanceOf(ResourceInboxLostReservationError);
    });
});
