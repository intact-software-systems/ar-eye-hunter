import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('runtime-state conditional writes', () => {
    it('applies writes only when the expected revision matches', async () => {
        const repository = new FakeRuntimeStateRepository();

        expect(
            await repository.insertIfAbsent(
                'state',
                'key',
                'v1',
                NEVER_EXPIRE_AT_TIMESTAMP,
            ),
        ).toEqual({ status: 'applied', revision: 0 });
        expect(
            await repository.insertIfAbsent(
                'state',
                'key',
                'v2',
                NEVER_EXPIRE_AT_TIMESTAMP,
            ),
        ).toEqual({ status: 'conflict' });
        expect(
            await repository.upsertIfRevision(
                'state',
                'key',
                'v2',
                NEVER_EXPIRE_AT_TIMESTAMP,
                0,
            ),
        ).toEqual({ status: 'applied', revision: 1 });
        expect(
            await repository.upsertIfRevision(
                'state',
                'key',
                'stale',
                NEVER_EXPIRE_AT_TIMESTAMP,
                0,
            ),
        ).toEqual({ status: 'conflict' });
        expect(await repository.deleteIfRevision('state', 'key', 0)).toEqual({
            status: 'conflict',
        });
        expect(await repository.deleteIfRevision('state', 'key', 1)).toEqual({
            status: 'applied',
        });
    });
});
