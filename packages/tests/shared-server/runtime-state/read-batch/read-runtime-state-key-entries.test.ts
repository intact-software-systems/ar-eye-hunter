import { describe, expect, it } from 'vitest';

import { readRuntimeStateKeyEntries } from '@shared-server/runtime-state/read-batch/read-runtime-state-key-entries.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';

import { FakeRuntimeStateRepository } from '../test-support/fake-runtime-state-repository.ts';

const NAMESPACE = 'key-entries';
const FAR_FUTURE_EPOCH_MS = Date.parse('9999-12-31T23:59:59.999Z');

interface LoggedRepository {
    readonly repository: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>;
    readonly reads: string[];
}

describe('readRuntimeStateKeyEntries', () => {
    it('reads one key alone', async () => {
        const { repository, reads } = await createLoggedRepository(['a']);

        const entries = await readRuntimeStateKeyEntries(repository, NAMESPACE, ['a']);

        expect(reads).toEqual(['find:a']);
        expect(entries.map((entry) => entry?.value)).toEqual(['"a"']);
    });

    it('reads several keys in one batch, answering each in the order asked and a missing one as undefined', async () => {
        const { repository, reads } = await createLoggedRepository(['a', 'c']);

        const entries = await readRuntimeStateKeyEntries(repository, NAMESPACE, ['c', 'missing', 'a']);

        expect(reads).toEqual(['batch:c,missing,a']);
        expect(entries.map((entry) => entry?.value)).toEqual(['"c"', undefined, '"a"']);
    });
});

async function createLoggedRepository(keys: readonly string[]): Promise<LoggedRepository> {
    const stored = new FakeRuntimeStateRepository();
    for (const key of keys) {
        await stored.upsert(NAMESPACE, key, JSON.stringify(key), FAR_FUTURE_EPOCH_MS);
    }
    const reads: string[] = [];
    return {
        reads,
        repository: {
            findEntry: (namespace, key) => {
                reads.push(`find:${key}`);
                return stored.findEntry(namespace, key);
            },
            readRuntimeStateBatch: (selectors) => {
                reads.push(`batch:${selectors.map((selector) => selector.kind === 'key' ? selector.key : selector.kind).join(',')}`);
                return stored.readRuntimeStateBatch(selectors);
            }
        }
    };
}
