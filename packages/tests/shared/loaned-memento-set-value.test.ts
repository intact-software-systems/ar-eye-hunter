import { LoanedMementoRepository } from '@shared/cache/LoanedMementoRepository.ts';
import { LoanedValue } from '@shared/cache/LoanedValue.ts';
import { describe, expect, it } from 'vitest';

// #248: setValue stored the value in the refresher closure rather than in the
// entry, so every synchronous reader reported the key as absent until someone
// awaited get(). peek() is the sharpest case — its whole purpose is to return
// the value regardless of expiry, and it could not see one just set.
describe('LoanedMementoRepository.setValue', () => {
    it('makes the value readable without awaiting', () => {
        const repository = new LoanedMementoRepository<string, number>(async () => 0);

        repository.setValue('k', 42);

        expect(repository.read('k')).toBe(42);
        expect(repository.peek('k')).toBe(42);
        expect(repository.hasValue('k')).toBe(true);
    });

    it('makes a committed value readable without awaiting', () => {
        const repository = new LoanedMementoRepository<string, number>(async () => 0);

        repository.commitValue('k', 7);

        expect(repository.read('k')).toBe(7);
        expect(repository.hasValue('k')).toBe(true);
    });

    it('still resolves the same value through the async path', async () => {
        const repository = new LoanedMementoRepository<string, number>(async () => 0);

        repository.setValue('k', 42);

        await expect(repository.get('k')).resolves.toBe(42);
        expect(repository.read('k')).toBe(42);
    });

    // A zero instant is a legal clock reading; the valueStartMs === 0 sentinel
    // used to make anything written at epoch zero read back as expired.
    it('treats a zero instant as a real time', () => {
        const loan = new LoanedValue<number>(async () => 0);

        loan.acceptAt(9, 0);

        expect(loan.readAt(0)).toBe(9);
        expect(loan.expiredAt(0)).toBe(false);
    });

    it('leaves the refresher path in charge when nothing was set', async () => {
        const repository = new LoanedMementoRepository<string, number>(async () => 5);

        expect(repository.read('k')).toBeUndefined();
        expect(repository.hasValue('k')).toBe(false);

        await expect(repository.get('k')).resolves.toBe(5);
        expect(repository.read('k')).toBe(5);
    });
});
