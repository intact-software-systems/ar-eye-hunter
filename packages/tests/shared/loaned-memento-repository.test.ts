import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoanedMementoRepository } from '@shared/cache/LoanedMementoRepository.ts';

describe('LoanedMementoRepository', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('refreshes values per key and preserves manual commits in undo/redo history', async () => {
        const repo = new LoanedMementoRepository<
            string,
            { version: number; content: string }
        >(
            async (key, current) => ({
                version: (current?.version ?? 0) + 1,
                content: `${key}:${(current?.version ?? 0) + 1}`,
            }),
            {
                ttlMs: 1_000,
                undoDepth: 3,
                redoDepth: 3,
            },
        );

        expect((await repo.get('doc-1')).version).toBe(1);
        expect((await repo.refresh('doc-1')).version).toBe(2);
        expect((await repo.get('doc-2')).version).toBe(1);

        repo.commitValue('doc-1', {
            version: 99,
            content: 'manual',
        });

        await expect(repo.get('doc-1')).resolves.toMatchObject({
            version: 99,
            content: 'manual',
        });
        expect(repo.undoStack('doc-1').map((value) => value.version)).toEqual([2]);
        expect(repo.undo('doc-1')?.version).toBe(2);
        expect(repo.redo('doc-1')?.version).toBe(99);
        expect((await repo.get('doc-1')).version).toBe(99);
        expect(repo.peek('doc-2')?.version).toBe(1);
    });

    it('coalesces concurrent gets for the same key while a refresh is in flight', async () => {
        let calls = 0;
        const deferred = createDeferred<number>();
        const repo = new LoanedMementoRepository<string, number>(
            async () => {
                calls += 1;
                return deferred.promise;
            },
            {
                ttlMs: 0,
            },
        );

        const first = repo.get('counter');
        const second = repo.get('counter');

        expect(calls).toBe(1);
        expect(repo.refreshing('counter')).toBe(true);

        deferred.resolve(5);

        await expect(Promise.all([first, second])).resolves.toEqual([5, 5]);
        expect(repo.peek('counter')).toBe(5);
        expect(repo.refreshing('counter')).toBe(false);
    });

    it('skips refreshing entries during deleteExpired and removes stale values via takeIfExpired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        let mode: 'initial' | 'refresh' = 'initial';
        const deferred = createDeferred<number>();
        const repo = new LoanedMementoRepository<string, number>(
            async (_key, current) => {
                if (mode === 'initial') {
                    return (current ?? 0) + 1;
                }

                return deferred.promise;
            },
            {
                ttlMs: 5,
            },
        );

        expect(await repo.get('job')).toBe(1);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.010Z'));
        mode = 'refresh';
        const refreshPromise = repo.refresh('job');

        expect(repo.refreshing('job')).toBe(true);
        expect(repo.deleteExpired()).toBe(0);
        expect(repo.has('job')).toBe(true);

        deferred.resolve(2);
        await expect(refreshPromise).resolves.toBe(2);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.020Z'));
        expect(repo.takeIfExpired('job')).toBe(2);
        expect(repo.has('job')).toBe(false);
    });
});

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error?: unknown) => void;

    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}
