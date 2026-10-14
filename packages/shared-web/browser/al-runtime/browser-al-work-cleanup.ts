import { Temporal } from '@js-temporal/polyfill';
import { AL_ADMISSION_WORK_COMPLETED_RETENTION } from '@shared/alm/al-admission-work-backend.ts';
import { AL_ADMISSION_WORK_STORE_NAME } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbConnection } from '@shared/persistence/open-indexed-db.ts';
import {
    decodeStoredResourceEntry,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueueDelete,
    type ComputedIndexedDbQueueMutation
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';

import type { BrowserALRuntimeDeletionPolicy } from './browser-al-runtime-cleanup.ts';

/**
 * The passes one cleanup may run. Each pass deletes at most one per-reason budget, so a store that
 * has accumulated more expired rows than that needs several; the bound stops a pass that keeps
 * reporting saturation without draining (the expiry index can front-run the precise instant by a
 * millisecond) from holding the caller open.
 */
const BROWSER_AL_WORK_CLEANUP_MAX_PASSES = 8;

/**
 * Hands expired/retention-expired AL work rows to the QueueBox's own bounded sweep, re-arming that
 * sweep's per-run budget until it drains or the pass bound is reached. `cleanupAsync` has no scoping
 * parameter, so every call here sweeps every session's AL work rows sharing this store, never just
 * one caller's session — only the plain KV admission-metadata rows are session-scoped (see
 * `deleteExpiredBrowserALRuntimeEntriesForSession`).
 */
export async function writeBrowserALWorkExpiryCleanup(db: IDBDatabase, nowMs: number): Promise<boolean> {
    const queueBox = new IndexedDbQueueBox({
        connection: new IndexedDbConnection(async () => db),
        storeName: AL_ADMISSION_WORK_STORE_NAME,
        completedRetention: AL_ADMISSION_WORK_COMPLETED_RETENTION,
        now: () => Temporal.Instant.fromEpochMilliseconds(nowMs),
        observer: createPassThroughIndexedDbOperationObserver()
    });
    let deleted = 0;
    for (let pass = 0; pass < BROWSER_AL_WORK_CLEANUP_MAX_PASSES; pass += 1) {
        const run = await queueBox.cleanupAsync();
        deleted += run.deleted;
        if (!run.saturated) {
            break;
        }
    }
    return deleted > 0;
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
