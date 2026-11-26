import { readIndexedDbRequest, readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import { IndexedDbConnection, openIndexedDbWithStores } from '@shared/persistence/open-indexed-db.ts';

interface EncryptedCredential {
    readonly id: string;
    readonly iv: Uint8Array<ArrayBuffer>;
    readonly ciphertext: ArrayBuffer;
}

const connection = new IndexedDbConnection(() => openIndexedDbWithStores('rallar-browser-credentials', [
    { name: 'keys', keyPath: 'id' }, { name: 'credentials', keyPath: 'id' }
]));
const encoder = new TextEncoder();

async function readRow<T>(table: string, id: string): Promise<T | undefined> {
    const db = await connection.open();
    const tx = db.transaction(table, 'readonly');
    return readIndexedDbTransaction(tx, () => readIndexedDbRequest<T | undefined>(tx.objectStore(table).get(id)));
}

/** Only the first contender persists its candidate. Later tabs use the existing key or retry proof. */
async function putRow<T extends { readonly id: string }>(table: string, row: T, first: boolean): Promise<T> {
    const db = await connection.open();
    const tx = db.transaction(table, 'readwrite');
    return readIndexedDbTransaction(tx, async () => {
        const store = tx.objectStore(table);
        if (first) {
            const existing: T | undefined = await readIndexedDbRequest(store.get(row.id));
            if (existing) return existing;
        }
        await readIndexedDbRequest(store.put(row));
        return row;
    });
}

async function originKey(): Promise<CryptoKey> {
    const saved = await readRow<{ key: CryptoKey }>('keys', 'origin');
    if (saved) return saved.key;
    const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    return (await putRow('keys', { id: 'origin', key }, true)).key;
}

async function seal(id: string, value: string): Promise<EncryptedCredential> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: encoder.encode(id)}, await originKey(), encoder.encode(value));
    return { id, iv, ciphertext };
}

async function open(row: EncryptedCredential): Promise<string> {
    const bytes = await crypto.subtle.decrypt({name: 'AES-GCM', iv: row.iv, additionalData: encoder.encode(row.id)}, await originKey(), row.ciphertext);
    return new TextDecoder().decode(bytes);
}

async function deleteRow(id: string, expected?: EncryptedCredential): Promise<void> {
    const db = await connection.open();
    const tx = db.transaction('credentials', 'readwrite');
    await readIndexedDbTransaction(tx, async () => {
        const store = tx.objectStore('credentials');
        if (expected) {
            const row: EncryptedCredential | undefined = await readIndexedDbRequest(store.get(id));
            if (!row || !expected.iv.every((byte, i) => row.iv[i] === byte)) return;
        }
        await readIndexedDbRequest(store.delete(id));
    });
}

export const browserCredentialStore = {
    async read(id: string): Promise<string | null> {
        const row = await readRow<EncryptedCredential>('credentials', id);
        return row ? open(row) : null;
    },
    async write(id: string, value: string): Promise<void> {
        await putRow('credentials', await seal(id, value), false);
    },
    async readOrCreate(id: string, value: string): Promise<string> {
        const existing = await readRow<EncryptedCredential>('credentials', id);
        if (existing) return open(existing);
        return open(await putRow('credentials', await seal(id, value), true));
    },
    async removeIfEqual(id: string, expected: string): Promise<void> {
        const row = await readRow<EncryptedCredential>('credentials', id);
        if (row && await open(row) === expected) await deleteRow(id, row);
    },
    remove(id: string): Promise<void> { return deleteRow(id); }
};
