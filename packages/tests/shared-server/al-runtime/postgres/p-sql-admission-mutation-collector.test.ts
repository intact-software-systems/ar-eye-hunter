import { afterEach, describe, expect, it, vi } from 'vitest';

import { PSqlAdmissionMutationCollector, type ALAdmissionMutation } from '@shared-server/al-runtime/postgres/p-sql-admission-mutation-collector.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

const NAMESPACE = 'al-admission-revisions';
const EXPIRES_AT_ISO = '1970-01-01T00:00:02.000Z';
const INVALID_REVISIONS = [
    { label: 'negative', revision: -1 },
    { label: 'negative zero', revision: -0 },
    { label: 'fractional', revision: 0.5 },
    { label: 'NaN', revision: Number.NaN },
    { label: 'negative infinity', revision: Number.NEGATIVE_INFINITY },
    { label: 'positive infinity', revision: Number.POSITIVE_INFINITY },
    { label: 'unsafe integer', revision: Number.MAX_SAFE_INTEGER + 1 }
] as const;

afterEach(() => {
    vi.restoreAllMocks();
});

describe.each(['replace', 'delete'] as const)('AL admission %s revision validation', (kind) => {
    const invalidRevisions = kind === 'replace'
        ? [...INVALID_REVISIONS, { label: 'increment overflow', revision: Number.MAX_SAFE_INTEGER }]
        : INVALID_REVISIONS;

    it.each(invalidRevisions.flatMap((invalid) => [
        { ...invalid, afterInsert: false },
        { ...invalid, afterInsert: true }
    ]))('rejects $label before begin (afterInsert=$afterInsert)', async ({ revision, afterInsert }) => {
        const repository = new FakeRuntimeStateRepository();
        const transactionCount = observeTransactionCount(repository);
        const writes: string[] = [];
        repository.beforeConditionalWrite = (operation, _namespace, key) => {
            writes.push(`${operation}:${key}`);
        };
        const collector = new PSqlAdmissionMutationCollector(repository, NAMESPACE, () => 1_000);
        const mutation: ALAdmissionMutation = kind === 'replace'
            ? {
                kind,
                key: 'target',
                expectedRevision: revision,
                value: '{"state":"replaced"}',
                expireAtIsoTimestamp: EXPIRES_AT_ISO
            }
            : { kind, key: 'target', expectedRevision: revision };
        const mutations = afterInsert ? [createInsert('first'), mutation] : [mutation];

        await expect(collector.apply(mutations)).rejects.toThrow(/revision/u);

        expect.soft(transactionCount()).toBe(0);
        expect.soft(writes).toEqual([]);
        expect(await repository.findAllEntries(NAMESPACE)).toEqual([]);
    });
});

describe('AL admission computed mutation application', () => {
    it.each([0, Number.MAX_SAFE_INTEGER - 1])('accepts replacement revision %s and persists the increment', async (revision) => {
        const repository = new FakeRuntimeStateRepository();
        repository.data.set(`${NAMESPACE}::target`, createStoredEntry('target', revision));
        const collector = new PSqlAdmissionMutationCollector(repository, NAMESPACE, () => 1_000);

        await collector.apply([{
            kind: 'replace',
            key: 'target',
            expectedRevision: revision,
            value: '{"state":"replaced"}',
            expireAtIsoTimestamp: EXPIRES_AT_ISO
        }]);

        expect(await repository.findEntry(NAMESPACE, 'target')).toMatchObject({
            key: 'target',
            value: '{"state":"replaced"}',
            expireAtTimestamp: 2_000,
            revision: revision + 1
        });
    });

    it.each([0, Number.MAX_SAFE_INTEGER])('accepts deletion revision %s', async (revision) => {
        const repository = new FakeRuntimeStateRepository();
        repository.data.set(`${NAMESPACE}::target`, createStoredEntry('target', revision));
        const collector = new PSqlAdmissionMutationCollector(repository, NAMESPACE, () => 1_000);

        await collector.apply([{ kind: 'delete', key: 'target', expectedRevision: revision }]);

        expect(await repository.findEntry(NAMESPACE, 'target')).toBeUndefined();
    });

    it('applies supplied insert, replace, and delete guards in order within one transaction', async () => {
        const repository = new FakeRuntimeStateRepository();
        const transactionCount = observeTransactionCount(repository);
        const collector = new PSqlAdmissionMutationCollector(repository, NAMESPACE, () => 1_000);

        await collector.apply([
            createInsert('target'),
            {
                kind: 'replace',
                key: 'target',
                expectedRevision: 0,
                value: '{"state":"replaced"}',
                expireAtIsoTimestamp: EXPIRES_AT_ISO
            },
            { kind: 'delete', key: 'target', expectedRevision: 1 }
        ]);

        expect(await repository.findEntry(NAMESPACE, 'target')).toBeUndefined();
        expect(transactionCount()).toBe(1);
    });

    it.each(['insert', 'replace', 'delete'] as const)('rolls back a sibling insert on a later %s CAS loss without retrying', async (kind) => {
        const repository = new FakeRuntimeStateRepository();
        const original = createStoredEntry('target', 2);
        repository.data.set(`${NAMESPACE}::target`, original);
        const transactionCount = observeTransactionCount(repository);
        const writes: string[] = [];
        repository.beforeConditionalWrite = (operation, _namespace, key) => {
            writes.push(`${operation}:${key}`);
        };
        const collector = new PSqlAdmissionMutationCollector(repository, NAMESPACE, () => 1_000);
        const mutation: ALAdmissionMutation = kind === 'insert'
            ? createInsert('target')
            : kind === 'replace'
            ? {
                kind,
                key: 'target',
                expectedRevision: 1,
                value: '{"state":"replaced"}',
                expireAtIsoTimestamp: EXPIRES_AT_ISO
            }
            : { kind, key: 'target', expectedRevision: 1 };

        await expect(collector.apply([createInsert('first'), mutation, createInsert('last')]))
            .rejects.toThrow(RuntimeStateWriteConflictError);

        expect(await repository.findAllEntries(NAMESPACE)).toEqual([original]);
        expect(writes).toHaveLength(2);
        expect(writes[0]).toBe('insertIfAbsent:first');
        expect(transactionCount()).toBe(1);
    });

    it('computes sorted JSON and ISO writes before applying their exact values', async () => {
        const repository = new FakeRuntimeStateRepository();
        const collector = new PSqlAdmissionMutationCollector(repository, NAMESPACE, () => 1_000);
        await collector.set('zeta', { value: 2 }, 3_000);
        await collector.set('alpha', { value: 1 }, 2_000);

        const mutations = collector.mutations();

        expect(mutations).toEqual([
            {
                kind: 'insert',
                key: 'alpha',
                expected: 'absent',
                value: '{"value":1}',
                expireAtIsoTimestamp: EXPIRES_AT_ISO
            },
            {
                kind: 'insert',
                key: 'zeta',
                expected: 'absent',
                value: '{"value":2}',
                expireAtIsoTimestamp: '1970-01-01T00:00:03.000Z'
            }
        ]);
        await collector.apply(mutations);

        expect(await repository.findEntry(NAMESPACE, 'alpha')).toMatchObject({ value: '{"value":1}', expireAtTimestamp: 2_000 });
        expect(await repository.findEntry(NAMESPACE, 'zeta')).toMatchObject({ value: '{"value":2}', expireAtTimestamp: 3_000 });
    });

    it('automatically deletes an observed expired MAX-revision entry while retaining live entries', async () => {
        const repository = new FakeRuntimeStateRepository();
        repository.data.set(`${NAMESPACE}::expired`, { ...createStoredEntry('expired', Number.MAX_SAFE_INTEGER), expireAtTimestamp: 1_000 });
        const live = createStoredEntry('live', 0);
        repository.data.set(`${NAMESPACE}::live`, live);
        const collector = new PSqlAdmissionMutationCollector(repository, NAMESPACE, () => 1_000);

        expect(await collector.read('expired', decodeState)).toBeUndefined();
        expect(await collector.list('', decodeState)).toEqual([{ key: 'live', value: { state: 'original' } }]);
        const mutations = collector.mutations();
        expect(mutations).toEqual([{ kind: 'delete', key: 'expired', expectedRevision: Number.MAX_SAFE_INTEGER }]);

        await collector.apply(mutations);

        expect(await repository.findAllEntries(NAMESPACE)).toEqual([live]);
    });
});

function createInsert(key: string): ALAdmissionMutation {
    return {
        kind: 'insert',
        key,
        expected: 'absent',
        value: '{"state":"inserted"}',
        expireAtIsoTimestamp: EXPIRES_AT_ISO
    };
}

function decodeState(value: unknown): Readonly<{ state: string; }> {
    if (value === null || typeof value !== 'object') {
        throw new TypeError('Test state must be an object');
    }
    const state = Reflect.get(value, 'state');
    if (typeof state !== 'string') {
        throw new TypeError('Test state.state must be a string');
    }
    return { state };
}

function createStoredEntry(key: string, revision: number): RuntimeStateEntry {
    return {
        key,
        value: '{"state":"original"}',
        expireAtTimestamp: 2_000,
        updatedTimestamp: '1970-01-01T00:00:00.000Z',
        revision
    };
}

function observeTransactionCount(repository: FakeRuntimeStateRepository): () => number {
    const begin = repository.begin.bind(repository);
    let count = 0;
    vi.spyOn(repository, 'begin').mockImplementation(async (fn) => {
        count += 1;
        return await begin(fn);
    });
    return () => count;
}
