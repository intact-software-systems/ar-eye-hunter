import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { browserCredentialStore } from '@shared-web/browser/auth/browser-credential-store.ts';
import { readIndexedDbRequest } from '@shared/persistence/indexed-db-request.ts';

it('encrypts each stored value with a fresh IV, authenticates its label, and keeps the origin key non-extractable', async () => {
    const store = browserCredentialStore;
    await store.write('court', 'private ticket');
    const db = await readIndexedDbRequest(indexedDB.open('rallar-browser-credentials'));
    const stored = () => readIndexedDbRequest(db.transaction('credentials').objectStore('credentials').get('court'));
    const first = await stored();
    const key = await readIndexedDbRequest(db.transaction('keys').objectStore('keys').get('origin'));
    expect(key.key.extractable).toBe(false);
    expect(new TextDecoder().decode(first.ciphertext)).not.toContain('private ticket');
    await store.write('court', 'private ticket');
    const next = await stored();
    expect([...next.iv]).not.toEqual([...first.iv]);
    await readIndexedDbRequest(db.transaction('credentials', 'readwrite').objectStore('credentials').put({ ...next, id: 'other' }));
    await expect(store.read('other')).rejects.toThrow();
    expect(await store.read('court')).toBe('private ticket');
    db.close();
});

it('chooses one durable proof across concurrent creators and guards delayed removal', async () => {
    const [a, b] = await Promise.all(['first', 'second'].map(value => browserCredentialStore.readOrCreate('pending', value)));
    expect(a).toBe(b);
    await browserCredentialStore.write('pending', 'new');
    await browserCredentialStore.removeIfEqual('pending', a);
    expect(await browserCredentialStore.read('pending')).toBe('new');
    await browserCredentialStore.removeIfEqual('pending', 'new');
    expect(await browserCredentialStore.read('pending')).toBeNull();
});
