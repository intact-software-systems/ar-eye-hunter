import { expect, it } from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import '../../setup-browser-indexeddb.ts';

it('commits queue-only ownership despite an unrelated metadata commit', async () => {
    const backend = new IndexedDbAdmissionBackend({
        dbName: `work-observation-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto)
    });
    const entry = workEntry();
    await expect(backend.write(async (tx) => {
        expect(await tx.readWork(entry.key)).toBeUndefined();
        await backend.write((other) => other.set('unrelated', 'changed'));
        tx.writeWork(entry);
        return 'owned';
    })).resolves.toBe('owned');
    expect((await backend.workQueue.getItem(entry.key))?.resource).toBe(entry.resource);
    expect(await backend.read('unrelated', String)).toBe('changed');
});

it.each(['read', 'list'] as const)('guards a metadata %s even when only queue rows are written', async (operation) => {
    const backend = new IndexedDbAdmissionBackend({
        dbName: `metadata-observation-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto)
    });
    const entry = workEntry();
    await expect(backend.write(async (tx) => {
        await tx[operation]('authority:', String);
        await tx.readWork(entry.key);
        await backend.write((other) => other.set('authority:new', 'revoked'));
        tx.writeWork(entry);
    })).rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
    expect(await backend.workQueue.getItem(entry.key)).toBeUndefined();
    expect(await backend.read('authority:new', String)).toBe('revoked');
});

it('guards every queue observation and atomically aborts sibling ownership on replacement', async () => {
    const backend = new IndexedDbAdmissionBackend({
        dbName: `queue-race-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto)
    });
    const entry = workEntry();
    const sibling = workEntry();
    await expect(backend.write(async (tx) => {
        await tx.readWork(entry.key);
        await tx.readWork(sibling.key);
        await backend.workQueue.enqueue(entry);
        tx.writeWork({ ...entry, resource: 'loser' });
        tx.writeWork(sibling);
    })).rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
    expect((await backend.workQueue.getItem(entry.key))?.resource).toBe(entry.resource);
    expect(await backend.workQueue.getItem(sibling.key)).toBeUndefined();
});

function workEntry() {
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALUnicastMessage('sender', newALEventRoute('test', crypto.randomUUID()), 'receiver', 'test', { value: 1 }),
        'TEST_WORK'
    );
}

it('permits post-deadline bookkeeping when no execution admission deadline applies', async () => {
    const nowMs = 1_800_000_001_000;
    const backend = new IndexedDbAdmissionBackend({
        dbName: `late-control-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: () => nowMs,
        newWriteToken: crypto.randomUUID.bind(crypto)
    });
    const entry = workEntry();
    await expect(backend.write(async (tx) => {
        await tx.readWork(entry.key);
        tx.writeWork(entry);
        await tx.set('late-control', 'recorded', nowMs + 60_000);
        return 'recorded';
    }, null)).resolves.toBe('recorded');
    expect(await backend.read('late-control', String)).toBe('recorded');
    expect((await backend.workQueue.getItem(entry.key))?.resource).toBe(entry.resource);
});
