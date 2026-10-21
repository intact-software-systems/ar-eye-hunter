import { describe, expect, it } from 'vitest';

import { settleAllInOrder } from '../../shared/resilience/settle-all-in-order.ts';

class PreferredFailure extends Error {}

const isPreferred = (failure: Error) => failure instanceof PreferredFailure;

describe('settleAllInOrder', () => {
    it('drains every operation before it rejects with the first failure in input order, not an aggregate', async () => {
        const first = new Error('first by input');
        const earlier = new Error('rejected earlier');
        let rejectFirst: (error: Error) => void = () => {};
        let finishLast: (value: number) => void = () => {};
        const pendingFirst = new Promise<number>((_resolve, reject) => {
            rejectFirst = reject;
        });
        const last = new Promise<number>((resolve) => {
            finishLast = resolve;
        });
        let returned = false;
        const outcome = settleAllInOrder([pendingFirst, Promise.reject(earlier), last], isPreferred)
            .catch((error: Error) => error)
            .then((value) => {
                returned = true;
                return value;
            });
        await new Promise((resolve) => setTimeout(resolve, 0));
        rejectFirst(first);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(returned).toBe(false);

        finishLast(3);

        expect(await outcome).toBe(first);
    });

    it('rejects with a preferred failure ahead of earlier ordinary ones', async () => {
        const preferred = new PreferredFailure('preferred');
        const laterPreferred = new PreferredFailure('later preferred');

        await expect(settleAllInOrder([
            Promise.reject(new Error('ordinary')),
            Promise.reject(preferred),
            Promise.reject(laterPreferred)
        ], isPreferred)).rejects.toBe(preferred);
    });

    it('normalizes a non-error rejection and resolves every value in input order on success', async () => {
        await expect(settleAllInOrder([Promise.reject('plain reason')], isPreferred)).rejects.toThrow('plain reason');
        await expect(settleAllInOrder([Promise.resolve(2), Promise.resolve(1)], isPreferred)).resolves.toEqual([2, 1]);
    });
});
