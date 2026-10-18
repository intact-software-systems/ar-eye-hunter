import { runInNewContext } from 'node:vm';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';

import '../../setup-browser-indexeddb.ts';

interface ObserverGateFixture {
    readonly backend: IndexedDbAdmissionBackend;
    readonly gate: PromiseWithResolvers<void>;
}

type ObservedOperation = 'read' | 'list' | 'write' | 'namespace-read' | 'unfenced-write';

const operations: readonly ObservedOperation[] = ['read', 'list', 'write', 'namespace-read', 'unfenced-write'];

afterEach(() => vi.restoreAllMocks());

describe.each(operations)('foreign-realm admission observer gate: %s', (operation) => {
    it('opens no storage transaction until its observer permits the operation', async () => {
        const { backend, gate } = await createObserverGate();
        const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
        const result = startOperation(backend, operation);
        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            // The observer contract gates the operation's first owned storage request.
            expect(transactions).not.toHaveBeenCalled();
        }
        finally {
            gate.resolve();
            await result;
            await backend.close();
        }
    });

    it('fails before opening storage or authoring a mutation when the observer rejects', async () => {
        const { backend, gate } = await createObserverGate();
        const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
        const result = startOperation(backend, operation);
        const rejected = expect(result).rejects.toThrow('observer rejected');
        gate.reject(new Error('observer rejected'));
        try {
            await rejected;
            expect(transactions).not.toHaveBeenCalled();
        }
        finally {
            transactions.mockRestore();
            await result.catch(() => {});
        }
        expect(await backend.read('authored', String)).toBeUndefined();
        await backend.close();
    });
});

async function createObserverGate(): Promise<ObserverGateFixture> {
    const gate: PromiseWithResolvers<void> = runInNewContext('Promise.withResolvers()');
    expect(gate.promise).not.toBeInstanceOf(Promise);
    // Keep the intentionally rejected foreign promise observed even on the broken implementation.
    void gate.promise.catch(() => {});
    let observed = false;
    const backend = new IndexedDbAdmissionBackend({
        dbName: `observer-gate-${crypto.randomUUID()}`,
        storeName: 'entries',
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        nowMs: () => 10,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: {
            observe: () => {
                if (!observed) {
                    observed = true;
                    return gate.promise;
                }
            }
        }
    });
    await backend.ready();
    return { backend, gate };
}

function startOperation(backend: IndexedDbAdmissionBackend, operation: ObservedOperation) {
    switch (operation) {
        case 'read':
            return backend.read('authored', String);
        case 'list':
            return backend.list('authored', String);
        case 'write':
            return backend.write((tx) => tx.set('authored', 'value'));
        case 'namespace-read':
            return backend.readNamespaceRows({
                keyPrefix: 'authored',
                workRanges: { namespacePrefixes: [], canonicalScopes: [] }
            });
        case 'unfenced-write':
            return backend.writeUnfencedMutations({
                mutations: [{
                    kind: 'set',
                    stored: { key: 'authored', value: 'value', expireAtTimestamp: 100, revision: 1, writeToken: 'token' }
                }],
                queueMutations: []
            });
    }
}
