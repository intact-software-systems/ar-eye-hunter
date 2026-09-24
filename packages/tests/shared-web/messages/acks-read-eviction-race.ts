import { onTestFinished, vi } from 'vitest';

import { BROWSER_AL_RUNTIME_DB_NAME } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import type { ALAdmissionDecoder } from '@shared/alm/al-admission-decoder.ts';
import { decodeALAdmissionControlValue } from '@shared/alm/al-admission-value-validation.ts';
import type { ALAdmissionReadSession } from '@shared/alm/al-admission-work-backend.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { IndexedDbAdmissionReadSession } from '@shared/alm/indexed-db-admission-read-session.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { toALOutboundControlHistoryKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';

/**
 * Plants the message's `acks` row already expired, then lands a second chain's read of that row
 * between the next read chain that reads it and that chain's eviction. The second chain evicts the
 * row first, so the first chain's write-token-guarded eviction finds it gone. Both chains and both
 * evictions are the sender store's own; only the interleaving belongs to the caller, and the
 * suite's `vi.restoreAllMocks()` removes it.
 */
export async function setNextAcksReadEvictionRaced(namespace: string, msgId: string): Promise<void> {
    const competitor = new IndexedDbAdmissionBackend({
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: createPassThroughIndexedDbOperationObserver(),
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    });
    const key = toALOutboundControlHistoryKey(namespace, 'acks', msgId);
    await competitor.write((transaction) => transaction.set(key, { kind: 'acks', values: [] }, Date.now() - 1));
    let raced = false;
    setNextReadChainInterleaved(key, async () => {
        raced = true;
        await competitor.read(key, (value) => decodeALAdmissionControlValue(value, msgId, 'acks'));
    });
    onTestFinished(() => {
        if (!raced) {
            throw new Error(`No read chain read ${key}, so the eviction race never ran`);
        }
    });
}

function setNextReadChainInterleaved(key: string, interleave: () => Promise<void>): void {
    const readers = new WeakSet<ALAdmissionReadSession>();
    const read = IndexedDbAdmissionReadSession.prototype.read;
    vi.spyOn(IndexedDbAdmissionReadSession.prototype, 'read').mockImplementation(async function<V> (
        this: IndexedDbAdmissionReadSession,
        readKey: string,
        decode: ALAdmissionDecoder<V>
    ): Promise<V | undefined> {
        if (readKey === key) {
            readers.add(this);
        }
        return await read.call<IndexedDbAdmissionReadSession, [string, ALAdmissionDecoder<V>], Promise<V | undefined>>(
            this,
            readKey,
            decode
        );
    });
    const readWithin = IndexedDbAdmissionBackend.prototype.readWithin;
    let pending = true;
    vi.spyOn(IndexedDbAdmissionBackend.prototype, 'readWithin').mockImplementation(async function<T> (
        this: IndexedDbAdmissionBackend,
        chain: (session: ALAdmissionReadSession) => Promise<T>
    ): Promise<T> {
        const interleaved = async (session: ALAdmissionReadSession): Promise<T> => {
            const result = await chain(session);
            if (pending && readers.has(session)) {
                pending = false;
                await interleave();
            }
            return result;
        };
        return await readWithin.call<IndexedDbAdmissionBackend, [typeof interleaved], Promise<T>>(this, interleaved);
    });
}
