import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestMementoRepository } from '@shared/cache/LatestMementoRepository.ts';

describe('LatestMementoRepository', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps history per key isolated and supports undo/redo', () => {
        const repo = new LatestMementoRepository<
            string,
            { content: string; version: number }
        >({
            undoDepth: 3,
            redoDepth: 3,
        });

        repo.accept('doc-1', { content: 'A', version: 1 });
        repo.accept('doc-1', { content: 'AB', version: 2 });
        repo.accept('doc-1', { content: 'ABC', version: 3 });
        repo.accept('doc-2', { content: 'X', version: 10 });
        repo.accept('doc-2', { content: 'XY', version: 20 });

        expect(repo.get('doc-1').version).toBe(3);
        expect(repo.undoStack('doc-1').map((value) => value.version)).toEqual([
            2, 1,
        ]);
        expect(repo.get('doc-2').version).toBe(20);

        expect(repo.undo('doc-1')?.version).toBe(2);
        expect(repo.get('doc-1').version).toBe(2);
        expect(repo.redo('doc-1')?.version).toBe(3);
        expect(repo.get('doc-2').version).toBe(20);
    });

    it('supports callback writes and compare-and-set style updates', () => {
        const repo = new LatestMementoRepository<string, number>({
            undoDepth: 3,
            redoDepth: 3,
        });
        const callback = repo.asCallback('counter');

        callback(1);
        callback(2);

        expect(repo.compareAndSet('counter', 1, 3)).toBe(false);
        expect(repo.compareAndSet('counter', 2, 3)).toBe(true);
        expect(repo.getAndSet('counter', 4)).toBe(3);
        expect(repo.get('counter')).toBe(4);
        expect(repo.undoStack('counter')).toEqual([3, 2, 1]);
        expect(repo.peekUndoValue('counter')).toBe(3);
    });

    it('extends ttl via touch and removes expired entries through takeIfExpired and deleteExpired', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repo = new LatestMementoRepository<string, number>({
            ttlMs: 100,
        });

        repo.accept('a', 1);
        repo.accept('b', 2);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.090Z'));
        expect(repo.touch('a')).toBe(true);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.110Z'));
        expect(repo.expired('a')).toBe(false);
        expect(repo.expired('b')).toBe(true);
        expect(repo.takeIfExpired('b')).toBe(2);
        expect(repo.has('b')).toBe(false);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.191Z'));
        expect(repo.deleteExpired()).toBe(1);
        expect(repo.size()).toBe(0);
    });
});
