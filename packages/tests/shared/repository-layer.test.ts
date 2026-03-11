import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestMementoRepository } from '@shared/cache/LatestMementoRepository.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { LoanedMementoRepository } from '@shared/cache/LoanedMementoRepository.ts';
import { LoanedRepository } from '@shared/cache/LoanedRepository.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { RepositoryToken } from '@shared/cache/RepositoryToken.ts';
import { latestMementoRepositoryToken, loanedMementoRepositoryToken, } from '@shared/cache/RepositoryTokens.ts';

describe('LatestRepository', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not overwrite existing falsy values when setIfAbsent is used', () => {
        const repo = new LatestRepository<string, number>();

        repo.set('count', 0);

        expect(repo.setIfAbsent('count', () => 1)).toBe(0);
        expect(repo.get('count')).toBe(0);
    });

    it('supports callback writes, updates, and expiry cleanup', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repo = new LatestRepository<string, number>({
            ttlMs: 10,
        });
        const callback = repo.asCallback('a');

        callback(1);
        repo.set('b', 2);

        expect(repo.updateIfPresent('a', (value) => value + 1)).toBe(true);
        expect(repo.updateIfPresent('missing', (value) => value + 1)).toBe(false);
        expect(repo.updateOrCreate('c', (value) => (value ?? 0) + 1)).toBe(true);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.005Z'));
        expect(repo.touch('a')).toBe(true);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.011Z'));
        expect(repo.takeIfExpired('b')).toBe(2);
        expect(repo.deleteExpired()).toBe(1);
        expect(repo.get('a')).toBe(2);
    });

    it('readAllValues returns every present value and filters expired entries', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repo = new LatestRepository<string, number>({ ttlMs: 10 });
        repo.set('a', 1);
        repo.set('b', 2);
        repo.set('c', 3);

        expect(repo.readAllValues().sort()).toEqual([1, 2, 3]);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.011Z'));
        expect(repo.readAllValues()).toEqual([]);
    });

    it('updateIfNewer creates, updates on higher version, and rejects stale writes', () => {
        type Versioned = Readonly<{ version: number; payload: string }>;
        const repo = new LatestRepository<string, Versioned>();
        const versionOf = (value: Versioned) => value.version;
        const onNewer = vi.fn();
        const onStale = vi.fn();

        expect(
            repo.updateIfNewer('k', { version: 1, payload: 'a' }, {
                versionOf,
                onNewer,
                onStale,
            }),
        ).toBe(true);
        expect(repo.read('k')).toEqual({ version: 1, payload: 'a' });
        expect(onNewer).not.toHaveBeenCalled();

        expect(
            repo.updateIfNewer('k', { version: 2, payload: 'b' }, {
                versionOf,
                onNewer,
                onStale,
            }),
        ).toBe(true);
        expect(repo.read('k')).toEqual({ version: 2, payload: 'b' });
        expect(onNewer).toHaveBeenCalledTimes(1);

        expect(
            repo.updateIfNewer('k', { version: 1, payload: 'old' }, {
                versionOf,
                onNewer,
                onStale,
            }),
        ).toBe(false);
        expect(repo.read('k')).toEqual({ version: 2, payload: 'b' });
        expect(onStale).toHaveBeenCalledTimes(1);

        expect(
            repo.updateIfNewer('k', { version: 2, payload: 'sameVersion' }, {
                versionOf,
                onNewer,
                onStale,
            }),
        ).toBe(false);
        expect(repo.read('k')).toEqual({ version: 2, payload: 'b' });
        expect(onStale).toHaveBeenCalledTimes(2);
    });

    it('readable returns a ReadableKeyedValues view backed by the repository', () => {
        const repo = new LatestRepository<string, number>();
        repo.set('a', 1);

        const view = repo.readable();
        expect(view.read('a')).toBe(1);
        expect(view.size()).toBe(1);

        repo.set('b', 2);
        expect(view.size()).toBe(2);
        expect(view.readAllValues().sort()).toEqual([1, 2]);
    });
});

describe('LoanedRepository', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('passes key and current value into default and override refreshers', async () => {
        const defaultCalls: Array<[string, number | undefined]> = [];
        const overrideCalls: Array<[string, number | undefined]> = [];
        const repo = new LoanedRepository<string, number>(
            async (key, current) => {
                defaultCalls.push([key, current]);
                return (current ?? key.length) + 1;
            },
            {
                ttlMs: 1_000,
            },
        );

        expect(await repo.get('aa')).toBe(3);
        expect(
            await repo.getWith('bb', async (key, current) => {
                overrideCalls.push([key, current]);
                return (current ?? 0) + 10;
            }),
        ).toBe(10);
        expect(
            await repo.refreshWith('aa', async (key, current) => {
                overrideCalls.push([key, current]);
                return (current ?? 0) + 5;
            }),
        ).toBe(8);

        expect(defaultCalls).toEqual([['aa', undefined]]);
        expect(overrideCalls).toEqual([
            ['bb', undefined],
            ['aa', 3],
        ]);
    });

    it('skips refreshing entries during deleteExpired and removes stale keys with takeIfExpired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const deferred = createDeferred<number>();
        let mode: 'initial' | 'refresh' = 'initial';
        const repo = new LoanedRepository<string, number>(
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

        deferred.resolve(2);
        await expect(refreshPromise).resolves.toBe(2);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.020Z'));
        expect(repo.takeIfExpired('job')).toBe(2);
        expect(repo.has('job')).toBe(false);
    });
});

describe('RepositoryManager', () => {
    it('resolves, replaces, deletes, and clears repositories with disposal semantics', async () => {
        const manager = new RepositoryManager();
        const created = {
            dispose: vi.fn(),
        };
        const createdToken = new RepositoryToken('created', () => created);
        const registered = {
            dispose: vi.fn(),
        };
        const registeredToken = new RepositoryToken('registered', () => registered);

        expect(manager.resolve(createdToken)).toBe(created);
        expect(manager.resolve(createdToken)).toBe(created);
        expect(manager.size()).toBe(1);

        manager.register(registeredToken, registered);
        expect(manager.require(registeredToken)).toBe(registered);
        expect(() => manager.register(registeredToken, registered)).toThrow(
            'Repository already registered: registered',
        );

        const replacement = {
            dispose: vi.fn(),
        };
        await manager.replace(registeredToken, replacement);

        expect(registered.dispose).toHaveBeenCalledOnce();
        expect(manager.get(registeredToken)).toBe(replacement);
        expect(await manager.delete('registered')).toBe(true);
        expect(replacement.dispose).toHaveBeenCalledOnce();

        const remaining = manager.require(createdToken);
        await manager.clear();

        expect(remaining.dispose).toHaveBeenCalledOnce();
        expect(manager.size()).toBe(0);
    });

    it('validates tokens and creates repository instances from token factories', () => {
        expect(
            () => new RepositoryToken('' as never, (() => ({})) as never),
        ).toThrow('RepositoryToken id is required');
        expect(
            () => new RepositoryToken('missing-create', undefined as never),
        ).toThrow('RepositoryToken create factory is required');

        const latestToken = latestMementoRepositoryToken<string, number>('latest', {
            ttlMs: 5,
        });
        const loanedToken = loanedMementoRepositoryToken<string, number>(
            'loaned',
            async (_key, current) => (current ?? 0) + 1,
            {
                ttlMs: 5,
            },
        );

        const latestRepo = latestToken.create();
        const loanedRepo = loanedToken.create();

        expect(latestRepo).toBeInstanceOf(LatestMementoRepository);
        expect(loanedRepo).toBeInstanceOf(LoanedMementoRepository);
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
