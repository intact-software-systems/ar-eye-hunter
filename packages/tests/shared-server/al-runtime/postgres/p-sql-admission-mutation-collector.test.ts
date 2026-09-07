import { describe, expect, it } from 'vitest';

import { PSqlAdmissionMutationCollector } from '@shared-server/al-runtime/postgres/p-sql-admission-mutation-collector.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

interface SenderVersion {
    readonly senderId: string;
    readonly version: number;
}

describe('PostgreSQL admission mutation collector validated reads', () => {
    it('decodes point, prefix, and buffered reads while keeping missing values absent', async () => {
        const repository = new FakeRuntimeStateRepository();
        const collector = new PSqlAdmissionMutationCollector(repository, 'admission', Date.now);
        await repository.upsert('admission', 'version:peer-1', '{"senderId":"peer-1","version":1}', NEVER_EXPIRE_AT_TIMESTAMP);

        expect(await collector.read('version:peer-1', decodeSenderVersion)).toEqual({ senderId: 'peer-1', version: 1 });
        expect(await collector.read('version:missing', decodeSenderVersion)).toBeUndefined();
        await collector.set('version:peer-2', { senderId: 'peer-2', version: 2 });
        expect(await collector.read('version:peer-2', decodeSenderVersion)).toEqual({ senderId: 'peer-2', version: 2 });
        expect(await collector.list('version:', decodeSenderVersion)).toEqual([
            { key: 'version:peer-1', value: { senderId: 'peer-1', version: 1 } },
            { key: 'version:peer-2', value: { senderId: 'peer-2', version: 2 } }
        ]);
        const mutations = collector.mutations();
        await repository.begin((transaction) => collector.writeMutations(transaction, mutations));
        expect((await repository.findEntry('admission', 'version:peer-2'))?.value).toBe('{"senderId":"peer-2","version":2}');
    });

    it.each([
        { label: 'malformed JSON', serialized: '{' },
        { label: 'missing mandatory fields', serialized: '{"senderId":"peer-1"}' },
        { label: 'wrong sender slot', serialized: '{"senderId":"peer-2","version":1}' }
    ])('rejects $label in point and prefix reads without writing pending work', async ({ serialized }) => {
        const repository = new FakeRuntimeStateRepository();
        const collector = new PSqlAdmissionMutationCollector(repository, 'admission', Date.now);
        await repository.upsert('admission', 'version:peer-1', serialized, NEVER_EXPIRE_AT_TIMESTAMP);

        await expect(collector.read('version:peer-1', decodeSenderVersion)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(collector.list('version:', decodeSenderVersion)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await collector.set('version:pending', { senderId: 'pending', version: 1 });
        await expect(collector.list('version:', decodeSenderVersion)).rejects.toMatchObject({ name: 'ALAdmissionCorruptionError', key: 'version:peer-1' });
        expect(await repository.findEntry('admission', 'version:pending')).toBeUndefined();
        expect((await repository.findEntry('admission', 'version:peer-1'))?.value).toBe(serialized);
    });

    it('validates buffered values before exposing them to the write callback', async () => {
        const repository = new FakeRuntimeStateRepository();
        const collector = new PSqlAdmissionMutationCollector(repository, 'admission', Date.now);

        await collector.set('version:peer-1', { senderId: 'peer-1', version: 1 });
        await collector.set('version:peer-2', { senderId: 'peer-2', version: 'bad' });
        await expect(collector.read('version:peer-2', decodeSenderVersion)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect(await repository.findAllEntries('admission')).toEqual([]);
    });

    it.each([
        { label: 'different point slot', key: 'version:peer-2', revision: 0, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP },
        { label: 'different prefix', key: 'other:peer-1', revision: 0, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP },
        { label: 'invalid revision', key: 'version:peer-1', revision: -1, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP },
        { label: 'invalid expiry', key: 'version:peer-1', revision: 0, expireAtTimestamp: Number.NaN },
        { label: 'negative expiry', key: 'version:peer-1', revision: 0, expireAtTimestamp: -1 },
        { label: 'negative-zero expiry', key: 'version:peer-1', revision: 0, expireAtTimestamp: -0 }
    ])('rejects an envelope with $label', async ({ key, revision, expireAtTimestamp }) => {
        const repository = new FakeRuntimeStateRepository();
        const collector = new PSqlAdmissionMutationCollector(repository, 'admission', Date.now);
        repository.data.set('admission::version:peer-1', {
            key,
            value: '{"senderId":"peer-1","version":1}',
            revision,
            expireAtTimestamp,
            updatedTimestamp: '2026-08-31T12:00:00.000Z'
        });

        await expect(collector.read('version:peer-1', decodeSenderVersion)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(collector.list('version:', decodeSenderVersion)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('keeps valid expired values absent but does not hide expired corruption', async () => {
        const repository = new FakeRuntimeStateRepository();
        const collector = new PSqlAdmissionMutationCollector(repository, 'admission', Date.now);
        await repository.upsert('admission', 'version:peer-1', '{"senderId":"peer-1","version":1}', 1);

        expect(await collector.read('version:peer-1', decodeSenderVersion)).toBeUndefined();
        expect(await collector.list('version:', decodeSenderVersion)).toEqual([]);
        await collector.set('version:peer-1', { senderId: 'peer-1', version: 2 });
        const mutations = collector.mutations();
        await repository.begin((transaction) => collector.writeMutations(transaction, mutations));
        expect(await collector.read('version:peer-1', decodeSenderVersion)).toEqual({ senderId: 'peer-1', version: 2 });

        await repository.upsert('admission', 'version:peer-2', '{"senderId":"wrong","version":1}', 1);
        await expect(collector.read('version:peer-2', decodeSenderVersion)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(collector.list('version:', decodeSenderVersion)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('retains a refreshed value when expired cleanup loses its observed revision', async () => {
        const repository = new FakeRuntimeStateRepository();
        const collector = new PSqlAdmissionMutationCollector(repository, 'admission', Date.now);
        await repository.upsert('admission', 'version:peer-1', '{"senderId":"peer-1","version":1}', 1);

        expect(await collector.read('version:peer-1', decodeSenderVersion)).toBeUndefined();
        await repository.upsert('admission', 'version:peer-1', '{"senderId":"peer-1","version":2}', NEVER_EXPIRE_AT_TIMESTAMP);
        const mutations = collector.mutations();
        await expect(repository.begin((transaction) => collector.writeMutations(transaction, mutations))).rejects.toBeInstanceOf(
            RuntimeStateWriteConflictError
        );
        expect((await repository.findEntry('admission', 'version:peer-1'))?.value).toBe('{"senderId":"peer-1","version":2}');
    });

    it('preserves repository failures instead of relabeling them as corruption', async () => {
        const repository = new FakeRuntimeStateRepository();
        const collector = new PSqlAdmissionMutationCollector(repository, 'admission', Date.now);
        const unavailable = new Error('storage unavailable');
        repository.beforeConditionalWrite = () => {
            throw unavailable;
        };

        await collector.set('version:peer-1', { senderId: 'peer-1', version: 1 });
        const mutations = collector.mutations();
        await expect(repository.begin((transaction) => collector.writeMutations(transaction, mutations))).rejects.toBe(unavailable);
        expect(await repository.findAllEntries('admission')).toEqual([]);
    });
});

function decodeSenderVersion(value: unknown, key: string): SenderVersion {
    if (
        typeof value !== 'object' || value === null ||
        !('senderId' in value) || typeof value.senderId !== 'string' ||
        !('version' in value) || typeof value.version !== 'number' ||
        !Number.isSafeInteger(value.version) || value.version < 0 ||
        key !== `version:${value.senderId}`
    ) {
        throw new TypeError('Stored sender version does not match its complete slot');
    }
    return { senderId: value.senderId, version: value.version };
}
