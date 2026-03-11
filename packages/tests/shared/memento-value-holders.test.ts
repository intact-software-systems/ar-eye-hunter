import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestMementoValue } from '@shared/cache/LatestMementoValue.ts';
import { LatestValue } from '@shared/cache/LatestValue.ts';
import { LoanedMementoValue } from '@shared/cache/LoanedMementoValue.ts';
import { LoanedValue } from '@shared/cache/LoanedValue.ts';
import { MementoLoanedValue } from '@shared/cache/MementoLoanedValues.ts';
import { MementoValue } from '@shared/cache/MementoValue.ts';

describe('MementoValue', () => {
    it('tracks bounded undo and redo history', () => {
        const memento = new MementoValue<string>({
            undoDepth: 2,
            redoDepth: 2,
        });

        memento.set('A').set('B').set('C');

        expect(memento.undoStack()).toEqual(['B', 'A']);
        expect(memento.undo()).toBe('B');
        expect(memento.redoStack()).toEqual(['C']);

        memento.set('D');

        expect(memento.read()).toBe('D');
        expect(memento.undoStack()).toEqual(['B', 'A']);
        expect(memento.redoStack()).toEqual([]);
    });

    it('copies snapshots without mutating the original instance', () => {
        const memento = new MementoValue<number>();
        memento.set(1);
        memento.compareAndSet(1, 2);
        expect(memento.getAndSet(3)).toBe(2);

        const copy = memento.copy();

        expect(copy.snapshot()).toEqual(memento.snapshot());
        expect(copy.undo()).toBe(2);
        expect(copy.read()).toBe(2);
        expect(memento.read()).toBe(3);
    });
});

describe('LatestMementoValue', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('captures raw values in undo and redo history', () => {
        const memento = LatestMementoValue.empty<number>({
            undoDepth: 2,
            redoDepth: 2,
        });
        const callback = memento.asCallback();

        callback(1);
        callback(2);

        expect(memento.undoStack()).toEqual([1]);
        expect(memento.undo()).toBe(1);
        expect(memento.redo()).toBe(2);
        expect(memento.get()).toBe(2);
    });

    it('delegates expiry to the current holder and takes expired values', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const memento = LatestMementoValue.fromValue(2, {
            ttlMs: 50,
        });

        vi.setSystemTime(new Date('2026-01-01T00:00:00.051Z'));

        expect(memento.expired()).toBe(true);
        expect(memento.takeIfExpired()).toBe(2);
        expect(memento.hasValue()).toBe(false);
    });

    it('compares current holders by identity when replacing them', () => {
        const first = new LatestValue<number>();
        first.accept(10);

        const second = new LatestValue<number>();
        second.accept(20);

        const memento = LatestMementoValue.fromLatest(first, {
            undoDepth: 2,
            redoDepth: 2,
        });

        expect(memento.compareAndSetLatest(second, undefined)).toBe(false);
        expect(memento.compareAndSetLatest(first, second)).toBe(true);
        expect(memento.undoStack()).toEqual([10]);
        expect(memento.undo()).toBe(10);
    });
});

describe('LoanedMementoValue', () => {
    it('can snapshot the current value into a fixed loan before recording new history', async () => {
        let source = 1;

        const memento = LoanedMementoValue.fromRefresher(async () => source, {
            undoDepth: 2,
            redoDepth: 2,
        });

        expect(await memento.get()).toBe(1);

        source = 2;
        memento.snapshotCurrentAsFixedLoan();
        source = 3;

        expect(await memento.refresh()).toBe(1);

        memento.setValue(5);
        expect(await memento.get()).toBe(5);

        expect(memento.undo()).toBe(1);
        expect(memento.redo()).toBe(5);
    });

    it('compares loan holders by identity when replacing them', async () => {
        const first = new LoanedValue(async () => 1);
        const second = new LoanedValue(async () => 2);

        await first.get();
        await second.get();

        const memento = new LoanedMementoValue(first, {
            undoDepth: 2,
            redoDepth: 2,
        });

        expect(memento.compareAndSetLoan(second, undefined)).toBe(false);
        expect(memento.compareAndSetLoan(first, second)).toBe(true);
        expect(memento.peekUndoValue()).toBe(1);
        expect(await memento.get()).toBe(2);
    });
});

describe('MementoLoanedValue', () => {
    it('stores loan objects in history and exposes them through undo and redo', async () => {
        const first = new LoanedValue(async () => 1);
        const second = new LoanedValue(async () => 2);

        await first.get();
        await second.get();

        const memento = new MementoLoanedValue(first, {
            undoDepth: 2,
            redoDepth: 2,
        });

        memento.setLoan(second);

        expect(memento.peekUndoLoan()).toBe(first);
        expect(memento.peekUndoValue()).toBe(1);
        expect(memento.undo()).toBe(first);
        expect(memento.peekRedoLoan()).toBe(second);
        expect(memento.redo()).toBe(second);
    });

    it('can snapshot the current resolved value into a fixed loan', async () => {
        let source = 1;

        const memento = MementoLoanedValue.fromRefresher(async () => source, {
            undoDepth: 2,
            redoDepth: 2,
        });

        const originalCurrent = memento.currentLoan();

        expect(await memento.get()).toBe(1);

        source = 2;
        await memento.snapshotCurrentValueIntoHistory();

        const snapshottedCurrent = memento.currentLoan();

        expect(snapshottedCurrent).not.toBe(originalCurrent);

        source = 5;
        expect(await memento.get()).toBe(1);

        memento.setValue(9);

        expect(memento.peekUndoLoan()).toBe(snapshottedCurrent);
        expect(memento.peekUndoValue()).toBe(1);
    });
});
