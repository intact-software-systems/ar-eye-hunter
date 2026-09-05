import { describe, expect, it } from 'vitest';

import { createParallelRendezvous } from '../../shared-test/black-box-runner/execution/parallel-rendezvous.ts';

describe('createParallelRendezvous', () => {
    it('releases nobody until every participant has arrived', async () => {
        const rendezvous = createParallelRendezvous(3);
        const released: number[] = [];

        const participants = [0, 1, 2].map((index) =>
            rendezvous.arrive().then(() => {
                released.push(index);
            })
        );

        expect(released).toEqual([]);
        await Promise.all(participants);
        expect(released.sort()).toEqual([0, 1, 2]);
    });

    it('does not release while a participant is still missing', async () => {
        const rendezvous = createParallelRendezvous(2);
        let releasedCount = 0;

        void rendezvous.arrive().then(() => {
            releasedCount += 1;
        });
        await Promise.resolve();

        expect(releasedCount).toBe(0);

        await rendezvous.arrive();
        await Promise.resolve();
        expect(releasedCount).toBe(1);
    });

    it('is a no-op for a single participant', async () => {
        const rendezvous = createParallelRendezvous(1);

        await expect(rendezvous.arrive()).resolves.toBeUndefined();
    });
});
