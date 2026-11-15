import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { LoanedMementoRepository } from '@shared/cache/LoanedMementoRepository.ts';

interface DocumentVersion {
    readonly version: number;
    readonly content: string;
}

describe('LoanedMementoRepository', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('refreshes values per key and preserves manual commits in undo/redo history', async () => {
        const repository = new LoanedMementoRepository<string, DocumentVersion>(
            async (key, current) => ({
                version: (current?.version ?? 0) + 1,
                content: `${key}:${(current?.version ?? 0) + 1}`
            }),
            {
                ttlMs: 1_000,
                undoDepth: 3,
                redoDepth: 3
            }
        );

        expect(repository.read('doc-1')).toBeUndefined();
        expect(repository.hasValue('doc-1')).toBe(false);
        expect((await repository.get('doc-1')).version).toBe(1);
        expect(repository.read('doc-1')).toEqual({ version: 1, content: 'doc-1:1' });
        expect((await repository.refresh('doc-1')).version).toBe(2);
        expect((await repository.get('doc-2')).version).toBe(1);

        repository.commitValue('doc-1', {
            version: 99,
            content: 'manual'
        });

        expect(repository.read('doc-1')).toEqual({ version: 99, content: 'manual' });
        expect(repository.hasValue('doc-1')).toBe(true);
        await expect(repository.get('doc-1')).resolves.toMatchObject({
            version: 99,
            content: 'manual'
        });
        expect(repository.undoStack('doc-1').map((value) => value.version)).toEqual([2]);
        expect(repository.undo('doc-1')?.version).toBe(2);
        expect(repository.redo('doc-1')?.version).toBe(99);
        expect((await repository.get('doc-1')).version).toBe(99);
        expect(repository.peek('doc-2')?.version).toBe(1);
    });

    it('makes an explicitly set value immediately readable and preserves it through an async read', async () => {
        const repository = new LoanedMementoRepository<string, number>(async () => 0);

        repository.setValue('k', 42);

        expect(repository.read('k')).toBe(42);
        expect(repository.peek('k')).toBe(42);
        expect(repository.hasValue('k')).toBe(true);
        await expect(repository.get('k')).resolves.toBe(42);
        expect(repository.read('k')).toBe(42);
    });

    it('makes a first committed value readable before any refresh', () => {
        const repository = new LoanedMementoRepository<string, number>(async () => 0);

        repository.commitValue('k', 7);

        expect(repository.read('k')).toBe(7);
        expect(repository.hasValue('k')).toBe(true);
    });

    it('coalesces concurrent gets for the same key while a refresh is in flight', async () => {
        let calls = 0;
        const deferred = Promise.withResolvers<number>();
        const repository = new LoanedMementoRepository<string, number>(
            async () => {
                calls += 1;
                return deferred.promise;
            },
            {
                ttlMs: 0
            }
        );

        const first = repository.get('counter');
        const second = repository.get('counter');

        expect(calls).toBe(1);
        expect(repository.refreshing('counter')).toBe(true);

        deferred.resolve(5);

        await expect(Promise.all([first, second])).resolves.toEqual([5, 5]);
        expect(repository.peek('counter')).toBe(5);
        expect(repository.refreshing('counter')).toBe(false);
    });

    it('skips refreshing entries during deleteExpired and removes stale values via takeIfExpired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        let mode: 'initial' | 'refresh' = 'initial';
        const deferred = Promise.withResolvers<number>();
        const repository = new LoanedMementoRepository<string, number>(
            async (_key, current) => {
                if (mode === 'initial') {
                    return (current ?? 0) + 1;
                }

                return deferred.promise;
            },
            {
                ttlMs: 5
            }
        );

        expect(await repository.get('job')).toBe(1);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.010Z'));
        mode = 'refresh';
        const refreshPromise = repository.refresh('job');

        expect(repository.refreshing('job')).toBe(true);
        expect(repository.deleteExpired()).toBe(0);
        expect(repository.has('job')).toBe(true);

        deferred.resolve(2);
        await expect(refreshPromise).resolves.toBe(2);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.020Z'));
        expect(repository.takeIfExpired('job')).toBe(2);
        expect(repository.has('job')).toBe(false);
    });
});
