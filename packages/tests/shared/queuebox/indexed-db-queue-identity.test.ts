import 'fake-indexeddb/auto';
import { expect, it, onTestFinished, vi } from 'vitest';

import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';

it.each(['omitted', 'empty'] as const)('rejects an %s database identity before any storage effect', (kind) => {
    const open = vi.spyOn(indexedDB, 'open');
    onTestFinished(() => open.mockRestore());
    const input = { dbName: '', observer: createPassThroughIndexedDbOperationObserver() };
    if (kind === 'omitted') {
        Reflect.deleteProperty(input, 'dbName');
    }
    expect(() => new IndexedDbQueueBox(input)).toThrow('requires an explicit database name or connection');
    expect(open).not.toHaveBeenCalled();
});

it('opens the exact caller-owned database identity without renaming it', async () => {
    const dbName = ` caller-owned-${crypto.randomUUID()} `;
    const queue = new IndexedDbQueueBox({ dbName, observer: createPassThroughIndexedDbOperationObserver() });
    expect(await queue.getAllKeys()).toEqual([]);
    expect((await indexedDB.databases()).some((database) => database.name === dbName)).toBe(true);
});
