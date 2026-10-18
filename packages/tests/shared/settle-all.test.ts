import { describe, expect, it } from 'vitest';

import { settleAll } from '../../shared/resilience/settle-all.ts';

describe('settleAll', () => {
    it('keeps failure pending until every sibling settles and preserves the first actual failure', async () => {
        const first = new Error('B failed first');
        const later = new Error('A failed later');
        let rejectA: (error: Error) => void = () => {};
        let finishC: (value: number) => void = () => {};
        const a = new Promise<number>((_resolve, reject) => {
            rejectA = reject;
        });
        const c = new Promise<number>((resolve) => {
            finishC = resolve;
        });
        let returned = false;
        const outcome = settleAll([a, Promise.reject(first), c]).catch((error: Error) => error).then((value) => {
            returned = true;
            return value;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        rejectA(later);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(returned).toBe(false);
        finishC(3);
        const failure = await outcome;
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) {
            throw new Error('Expected every failure to remain observable');
        }
        expect(failure.cause).toBe(first);
        expect(failure.errors).toEqual([first, later]);
        expect(failure.message).toBe('B failed first');
    });

    it('retains a sole failure by identity and results in input order on success', async () => {
        const failure = new Error('terminal');
        await expect(settleAll([Promise.resolve(1), Promise.reject(failure)])).rejects.toBe(failure);
        await expect(settleAll([Promise.resolve(2), Promise.resolve(1)])).resolves.toEqual([2, 1]);
    });

    it('preserves one shared failure when multiple operations reject with the same cause', async () => {
        const failure = new Error('shared transport failure');
        await expect(settleAll([Promise.reject(failure), Promise.reject(failure)])).rejects.toBe(failure);
    });

    it.each([
        { description: 'no string conversion', reason: Object.create(null) },
        {
            description: 'throwing string conversion',
            reason: {
                toString() {
                    throw new Error('conversion failed');
                }
            }
        },
        { description: 'undefined rejection', reason: undefined }
    ])('drains a pending sibling and preserves a rejection with $description', async ({ reason }) => {
        const sibling = Promise.withResolvers<number>();
        let completed = false;
        const outcome = settleAll([Promise.reject(reason), sibling.promise]).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (failure) => ({ status: 'rejected' as const, reason: failure })
        ).finally(() => {
            completed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const completedBeforeDrain = completed;
        sibling.resolve(1);
        const result = await outcome;

        expect(completedBeforeDrain).toBe(false);
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
            expect(result.reason).toBe(reason);
        }
    });

    it('retains unstringifiable and Error rejection reasons in their actual observed order', async () => {
        const later = Promise.withResolvers<number>();
        const primary = Object.create(null);
        const secondary = new Error('later failure');
        const outcome = settleAll([later.promise, Promise.reject(primary)]).catch((failure: Error) => failure);
        await new Promise((resolve) => setTimeout(resolve, 0));
        later.reject(secondary);
        const result = await outcome;

        expect(result).toBeInstanceOf(AggregateError);
        if (result instanceof AggregateError) {
            expect(result.cause).toBe(primary);
            expect(result.errors).toEqual([primary, secondary]);
        }
    });

    it('retains primary and secondary failures when the primary message getter throws', async () => {
        const primary = new Error();
        Object.defineProperty(primary, 'message', {
            get: () => {
                throw new Error('message getter failed');
            }
        });
        const secondary = new Error('cleanup failed');
        const outcome = await settleAll([Promise.reject(primary), Promise.reject(secondary)]).catch((failure: Error) => failure);

        expect(outcome).toBeInstanceOf(AggregateError);
        if (outcome instanceof AggregateError) {
            expect(outcome.cause).toBe(primary);
            expect(outcome.errors[0]).toBe(primary);
            expect(outcome.errors[1]).toBe(secondary);
            expect(outcome.message).toBe('Multiple operations failed');
        }
    });
});
