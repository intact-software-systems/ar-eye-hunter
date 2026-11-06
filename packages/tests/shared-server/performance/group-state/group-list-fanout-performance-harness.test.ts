import { describe, expect, it } from 'vitest';
import { CountingRuntimeStateRepository } from '../../../../../scripts/platform/perf/counting-runtime-state-repository.ts';

describe('group list fanout performance harness repository', () => {
    it('preserves optimistic insert, update, and delete conflict semantics', async () => {
        expect(CountingRuntimeStateRepository).toBeTypeOf('function');
        const repository = new CountingRuntimeStateRepository();

        await expect(repository.insertIfAbsent({ namespace: 'state', key: 'key', value: 'one', expireAtTimestamp: 10 }))
            .resolves.toEqual({ status: 'applied', revision: 0 });
        await expect(repository.insertIfAbsent({ namespace: 'state', key: 'key', value: 'duplicate', expireAtTimestamp: 20 }))
            .resolves.toEqual({ status: 'conflict' });
        await expect(repository.upsertIfRevision({ namespace: 'state', key: 'key', value: 'stale', expireAtTimestamp: 30, expectedRevision: 1 }))
            .resolves.toEqual({ status: 'conflict' });
        await expect(repository.upsertIfRevision({ namespace: 'state', key: 'key', value: 'two', expireAtTimestamp: 40, expectedRevision: 0 }))
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
