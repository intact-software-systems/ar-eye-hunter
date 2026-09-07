import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import { decodeALAdmissionRecord } from '@shared/alm/al-admission-value-validation.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { AL_ADMISSION_WORK_STORE_NAME } from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    decodeALOutboundCanonicalMessage,
    decodeALOutboundIdentityFact,
    toALOutboundIdentityKey
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { toALOutboundWorkKey, toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import {
    decodeStoredResourceEntry,
    decodeStoredResourceEntryValue,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueueDelete,
    type ComputedIndexedDbQueueMutation
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { isKeysEqual, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';

import type { BrowserALRuntimeDeletionPolicy } from './browser-al-runtime-cleanup.ts';
import {
    BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX,
    toBrowserSessionALRuntimeEntryKeyPrefixes
} from './browser-al-runtime-identity.ts';

/** Reads retained facts directly: QueueBox read APIs may themselves evict expired rows. */
export async function readBrowserALWorkCleanupRows(
    db: IDBDatabase,
    keyPrefixes: readonly string[],
    policy: BrowserALRuntimeDeletionPolicy
): Promise<readonly StoredResourceEntry[]> {
    const tx = db.transaction(AL_ADMISSION_WORK_STORE_NAME, 'readonly');
    const rows = await readIndexedDbTransaction(
        tx,
        async () =>
            await new Promise<readonly StoredResourceEntry[]>((resolve, reject) => {
                const found: StoredResourceEntry[] = [];
                const request = tx.objectStore(AL_ADMISSION_WORK_STORE_NAME).openCursor(
                    IDBKeyRange.bound('AL_INBOUND', 'AL_OUTBOUND\uffff')
                );
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    try {
                        const cursor = request.result;
                        if (!cursor) {
                            resolve(found);
                            return;
                        }
                        found.push(decodeStoredResourceEntryValue(cursor.value));
                        cursor.continue();
                    }
                    catch (error) {
                        reject(error);
                    }
                };
            })
    );
    return selectBrowserALWorkCleanupRows(rows, keyPrefixes, policy);
}

function selectBrowserALWorkCleanupRows(
    rows: readonly StoredResourceEntry[],
    keyPrefixes: readonly string[],
    policy: BrowserALRuntimeDeletionPolicy
): readonly StoredResourceEntry[] {
    const byKey = new Map(rows.map((row) => [row.keyString, row]));
    const selected = new Map<string, StoredResourceEntry>();
    for (const row of rows) {
        if (row.key.topicId === 'AL_INBOUND') {
            if (isSelectedInboundWork(row, keyPrefixes)) {
                selected.set(row.keyString, row);
            }
            continue;
        }
        // Expired QueueBox getters can remove the identity first. Global expiry owns
        // this reserved canonical topic; scoped/live deletion still requires the full fact.
        if (
            policy.kind === 'expired' && keyPrefixes.includes(BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX) &&
            row.key.topicId === 'AL_OUTBOUND_MESSAGE' &&
            decodeStoredResourceEntry(row).audit.expiryTs.epochMilliseconds <= policy.nowMs
        ) {
            const deadline = resolveALMessageExpireAtMs(decodePersistedALMessage(row.resource));
            if (deadline === undefined || deadline > policy.nowMs) {
                throw new TypeError('Expired browser canonical row has a live or missing message deadline');
            }
            selected.set(row.keyString, row);
        }
        if (row.typeId === 'AL_OUTBOUND_IDENTITY') {
            const reference = decodeALOutboundIdentityFact(JSON.parse(row.resource)).reference;
            if (!isKeysEqual(row.key, toALOutboundIdentityKey(reference.key))) {
                throw new TypeError('Browser outbound identity fact differs from its physical slot');
            }
            if (!isSelectedBrowserCanonicalScope(reference.scope, keyPrefixes)) {
                continue;
            }
            const canonical = byKey.get(toKeyAsString(reference.key));
            if (canonical) {
                decodeALOutboundCanonicalMessage(
                    reference,
                    decodeStoredResourceEntry(canonical),
                    decodeStoredResourceEntry(row)
                );
                selected.set(canonical.keyString, canonical);
            }
            selected.set(row.keyString, row);
        }
        if (row.typeId.startsWith('AL_OUTBOUND:') && isSelectedOutboundWork(row, keyPrefixes)) {
            selected.set(row.keyString, row);
        }
    }
    return [...selected.values()];
}

function isSelectedOutboundWork(row: StoredResourceEntry, keyPrefixes: readonly string[]): boolean {
    const work = decodeALAdmissionRecord(JSON.parse(row.resource), ['namespace', 'effectId', 'payload']);
    if (
        typeof work.namespace !== 'string' || typeof work.effectId !== 'string' ||
        row.typeId !== toALOutboundWorkType(work.namespace) ||
        !isKeysEqual(row.key, toALOutboundWorkKey(work.namespace, work.effectId))
    ) {
        throw new TypeError('Browser outbound action differs from its namespace or physical slot');
    }
    const namespace = work.namespace;
    return keyPrefixes.some((prefix) => namespace.startsWith(prefix));
}

function isSelectedInboundWork(row: StoredResourceEntry, keyPrefixes: readonly string[]): boolean {
    const work = decodeALAdmissionRecord(JSON.parse(row.resource), ['namespace', 'effectId', 'payload']);
    if (typeof work.namespace !== 'string') {
        throw new TypeError('Browser inbound work has no full namespace');
    }
    const namespace = work.namespace;
    decodeALInboundWorkEntry(decodeStoredResourceEntry(row), namespace);
    return keyPrefixes.some((prefix) => namespace.startsWith(prefix));
}

function isSelectedBrowserCanonicalScope(scope: string, keyPrefixes: readonly string[]): boolean {
    if (!scope.startsWith('browser-session:')) {
        return keyPrefixes.some((prefix) => scope.startsWith(prefix));
    }
    const sessionId = scope.slice('browser-session:'.length);
    return toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId).some((owned) =>
        keyPrefixes.some((prefix) => owned.startsWith(prefix))
    );
}

export function computeBrowserALWorkCleanupMutations(
    rows: readonly StoredResourceEntry[],
    policy: BrowserALRuntimeDeletionPolicy
): readonly ComputedIndexedDbQueueMutation[] {
    return rows.filter((row) =>
        policy.kind === 'all' ||
        decodeStoredResourceEntry(row).audit.expiryTs.epochMilliseconds <= policy.nowMs
    ).map(computeIndexedDbQueueDelete);
}
