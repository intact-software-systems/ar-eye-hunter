import { describe, expect, it, vi } from 'vitest';

describe('group list fanout performance harness repository', () => {
    it('preserves optimistic insert, update, and delete conflict semantics', async () => {
        vi.stubGlobal('Deno', { args: [] });
        const bench = await import('../../../../../scripts/perf/group-list-fanout-bench.ts');
        expect(bench.CountingRuntimeStateRepository).toBeTypeOf('function');
        const repository = new bench.CountingRuntimeStateRepository();

        await expect(repository.insertIfAbsent('state', 'key', 'one', new Date(10).toISOString()))
            .resolves.toEqual({ status: 'applied', revision: 0 });
        await expect(repository.insertIfAbsent('state', 'key', 'duplicate', new Date(20).toISOString()))
            .resolves.toEqual({ status: 'conflict' });
        await expect(repository.upsertIfRevision('state', 'key', 'stale', new Date(30).toISOString(), 1))
            .resolves.toEqual({ status: 'conflict' });
        await expect(repository.upsertIfRevision('state', 'key', 'two', new Date(40).toISOString(), 0))
            .resolves.toEqual({ status: 'applied', revision: 1 });
        expect(await repository.findEntry('state', 'key')).toMatchObject({
            value: 'two',
            revision: 1
        });
        await expect(repository.deleteIfRevision('state', 'key', 0))
            .resolves.toEqual({ status: 'conflict' });
        await expect(repository.deleteIfRevision('state', 'key', 1))
            .resolves.toEqual({ status: 'applied' });
        await expect(repository.deleteIfRevision('state', 'key', 1))
            .resolves.toEqual({ status: 'conflict' });
    });
});
