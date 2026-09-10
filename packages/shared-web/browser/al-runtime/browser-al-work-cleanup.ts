import { Temporal } from '@js-temporal/polyfill';
import { AL_ADMISSION_WORK_COMPLETED_RETENTION } from '@shared/alm/al-admission-work-backend.ts';
import { toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { AL_ADMISSION_WORK_STORE_NAME } from '@shared/alm/open-indexed-db-admission-database.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import { IndexedDbConnection } from '@shared/persistence/open-indexed-db.ts';
import { fnv1a64 } from '@shared/queuebox/AppQueueIdentity.ts';
import {
    decodeStoredResourceEntry,
    decodeStoredResourceEntryValue,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueueDelete,
    type ComputedIndexedDbQueueMutation
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';

import type { BrowserALRuntimeDeletionPolicy } from './browser-al-runtime-cleanup.ts';

/** High sentinel code point: bounds a string-prefix IndexedDB key range from above. */
const KEY_RANGE_UPPER_SENTINEL = '\uffff';

export interface BrowserALWorkCleanupRangesInput {
    readonly namespacePrefixes: readonly string[];
    readonly canonicalScopes: readonly string[];
}

/**
 * One bounded range per owned AL_INBOUND/AL_OUTBOUND namespace and per owned canonical scope.
 * The namespace's own work-key builders compute each bound: `toAppQueueKey` hash-truncates any
 * part over its length limit, so a long browser namespace is not a literal prefix of its own key.
 * Every stored key is `topicId/resourceId/contextId`; each range ends its resourceId with the `/`
 * delimiter so a resourceId that is itself a string prefix of another owner's resourceId (e.g.
 * `abc` vs `abc123`) can't pull that other owner's rows into this range too.
 */
export function toBrowserALWorkCleanupRanges(
    input: BrowserALWorkCleanupRangesInput
): readonly IDBKeyRange[] {
    const ranges: IDBKeyRange[] = [];
    for (const namespace of input.namespacePrefixes) {
        const inboundResourceId = toALInboundWorkKey(namespace, '').resourceId;
        const outboundResourceId = toALOutboundWorkKey(namespace, '').resourceId;
        ranges.push(
            IDBKeyRange.bound(
                `AL_INBOUND/${inboundResourceId}/`,
                `AL_INBOUND/${inboundResourceId}/${KEY_RANGE_UPPER_SENTINEL}`
            )
        );
        ranges.push(
            IDBKeyRange.bound(
                `AL_OUTBOUND/${outboundResourceId}/`,
                `AL_OUTBOUND/${outboundResourceId}/${KEY_RANGE_UPPER_SENTINEL}`
            )
        );
    }
    for (const scope of input.canonicalScopes) {
        const hashed = `scope-${fnv1a64(scope)}`;
        ranges.push(IDBKeyRange.bound(
            `AL_OUTBOUND_MESSAGE/${hashed}/`,
            `AL_OUTBOUND_MESSAGE/${hashed}/${KEY_RANGE_UPPER_SENTINEL}`
        ));
        ranges.push(IDBKeyRange.bound(
            `AL_OUTBOUND_IDENTITY/${hashed}/`,
            `AL_OUTBOUND_IDENTITY/${hashed}/${KEY_RANGE_UPPER_SENTINEL}`
        ));
    }
    return ranges;
}

/** Reads retained facts directly: QueueBox read APIs may themselves evict expired rows. */
export async function readBrowserALWorkCleanupRows(
    db: IDBDatabase,
    input: BrowserALWorkCleanupRangesInput
): Promise<readonly StoredResourceEntry[]> {
    const ranges = toBrowserALWorkCleanupRanges(input);
    const tx = db.transaction(AL_ADMISSION_WORK_STORE_NAME, 'readonly');
    return await readIndexedDbTransaction(tx, async () => {
        const store = tx.objectStore(AL_ADMISSION_WORK_STORE_NAME);
        const found: StoredResourceEntry[] = [];
        for (const range of ranges) {
            found.push(...await readBrowserALWorkCleanupRange(store, range));
        }
        return found;
    });
}

function readBrowserALWorkCleanupRange(
    store: IDBObjectStore,
    range: IDBKeyRange
): Promise<readonly StoredResourceEntry[]> {
    return new Promise((resolve, reject) => {
        const found: StoredResourceEntry[] = [];
        const request = store.openCursor(range);
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
    });
}

/**
 * Hands expired/retention-expired AL work rows to the QueueBox's own bounded sweep. `cleanupAsync`
 * has no scoping parameter, so every call here sweeps every session's AL work rows sharing this
 * store, never just one caller's session — only the plain KV admission-metadata rows are
 * session-scoped (see `deleteExpiredBrowserALRuntimeEntriesForSession`).
 */
export async function writeBrowserALWorkExpiryCleanup(db: IDBDatabase, nowMs: number): Promise<boolean> {
    const queueBox = new IndexedDbQueueBox({
        connection: new IndexedDbConnection(async () => db),
        storeName: AL_ADMISSION_WORK_STORE_NAME,
        completedRetention: AL_ADMISSION_WORK_COMPLETED_RETENTION,
        now: () => Temporal.Instant.fromEpochMilliseconds(nowMs),
        observer: createPassThroughIndexedDbOperationObserver()
    });
    return await queueBox.cleanupAsync();
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
