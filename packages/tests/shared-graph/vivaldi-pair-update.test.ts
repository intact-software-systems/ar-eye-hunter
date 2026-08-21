import { clearAllNodes, getNodeById } from '@shared-graph/repository/vivaldi-repository.ts';
import { observeRtt } from '@shared-graph/vivaldi-service.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

const TARGET_RTT_MS = 50;

// These run through observeRtt itself, so the nodes come from the repository
// with the live Math.random. That is the point: the property below has to hold
// without controlling the draw.
function observePairDistance(samples: number): number {
    clearAllNodes();

    for (let sample = 0; sample < samples; sample++) {
        observeRtt({
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: TARGET_RTT_MS,
            createdAtEpochMs: 0,
            version: 1
        });
    }

    const from = getNodeById('session-a');
    const to = getNodeById('session-b');
    if (!from || !to) {
        throw new Error('observeRtt did not create both nodes');
    }

    return from.coords.subtract(to.coords).norm();
}

function observePairPosition(samples: number): number[] {
    observePairDistance(samples);
    return getNodeById('session-a')!.coords.values;
}

describe('observeRtt pair updates', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        clearAllNodes();
    });

    // The control for everything below. Two fresh nodes are collocated, so the
    // first update takes the random tie-break and the pair lands somewhere
    // different in space every time. Without this, a stable distance could just
    // mean the randomness was not reached.
    it('places the pair somewhere different on every run', () => {
        const positions = Array.from({ length: 8 }, () => observePairPosition(1).join(','));

        expect(new Set(positions).size).toBeGreaterThan(1);
    });

    // observeRtt updates the from-node and then feeds its *new* state into the
    // to-node's update. That coupling is what makes the separation between them
    // independent of the direction the pair happened to pick: the second node
    // moves directly away from where the first one just went.
    //
    // Predicted RTT reads this distance and nothing else, so the ordering is
    // load-bearing. Snapshotting both nodes before either update -- which looks
    // like the obvious symmetry fix -- makes both take independent tie-breaks
    // and turns this distance back into a random variable.
    // Agreement is to ~15 significant digits rather than bit-for-bit: the drawn
    // unit vector is only unit-length up to rounding, so the cancellation
    // leaves a last-place difference that varies with the draw. The margin here
    // is still 10 orders of magnitude tighter than the spread the snapshot
    // ordering produces, which ranges from 0.9 to 12.4 after one observation.
    it.each([
        { samples: 1, expected: 11.71875 },
        { samples: 2, expected: 20.819243499393782 }
    ])('separates the pair by $expected after $samples', ({ samples, expected }) => {
        const distances = Array.from({ length: 8 }, () => observePairDistance(samples));

        for (const distance of distances) {
            expect(distance).toBeCloseTo(expected, 9);
        }
    });

    it('converges to the measured RTT regardless of the draw', () => {
        const distances = Array.from({ length: 8 }, () => observePairDistance(100));

        for (const distance of distances) {
            expect(distance).toBeCloseTo(TARGET_RTT_MS, 9);
            expect(distance).toBeCloseTo(distances[0], 9);
        }
    });
});
