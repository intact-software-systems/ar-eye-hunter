import { readIndexedDbTransaction } from '../../persistence/indexed-db-request.ts';
import { fnv1a64 } from '../../queuebox/AppQueueIdentity.ts';
import {
    decodeStoredResourceEntryValue,
    type StoredResourceEntry
} from '../../queuebox/indexed-db-queue-box-entry-codec.ts';
import { toALInboundWorkKey } from '../inbound/al-inbound-work-entry.ts';
import { AL_ADMISSION_WORK_STORE_NAME } from '../open-indexed-db-admission-database.ts';
import { toALOutboundWorkKey } from '../outbound/al-outbound-work-entry.ts';

/** High sentinel code point: bounds a string-prefix IndexedDB key range from above. */
const KEY_RANGE_UPPER_SENTINEL = '￿';

export interface ALWorkKeyRangesInput {
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
export function toALWorkKeyRanges(input: ALWorkKeyRangesInput): readonly IDBKeyRange[] {
    const ranges: IDBKeyRange[] = [];
    for (const namespace of input.namespacePrefixes) {
        const inboundResourceId = toALInboundWorkKey(namespace, '').resourceId;
        const outboundResourceId = toALOutboundWorkKey(namespace, '').resourceId;
        ranges.push(toALWorkKeyRange('AL_INBOUND', inboundResourceId));
        ranges.push(toALWorkKeyRange('AL_OUTBOUND', outboundResourceId));
    }
    for (const scope of input.canonicalScopes) {
        const hashed = `scope-${fnv1a64(scope)}`;
        ranges.push(toALWorkKeyRange('AL_OUTBOUND_MESSAGE', hashed));
        ranges.push(toALWorkKeyRange('AL_OUTBOUND_IDENTITY', hashed));
    }
    return ranges;
}

/** Reads retained facts directly: QueueBox read APIs may themselves evict expired rows. */
export async function readALWorkRowsInRanges(
    db: IDBDatabase,
    input: ALWorkKeyRangesInput
): Promise<readonly StoredResourceEntry[]> {
    const ranges = toALWorkKeyRanges(input);
    const tx = db.transaction(AL_ADMISSION_WORK_STORE_NAME, 'readonly');
    return await readIndexedDbTransaction(tx, async () => {
        const store = tx.objectStore(AL_ADMISSION_WORK_STORE_NAME);
        const found: StoredResourceEntry[] = [];
        for (const range of ranges) {
            found.push(...await readALWorkRowsInRange(store, range));
        }
        return found;
    });
}

function toALWorkKeyRange(topicId: string, resourceId: string): IDBKeyRange {
    return IDBKeyRange.bound(`${topicId}/${resourceId}/`, `${topicId}/${resourceId}/${KEY_RANGE_UPPER_SENTINEL}`);
}

function readALWorkRowsInRange(
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
