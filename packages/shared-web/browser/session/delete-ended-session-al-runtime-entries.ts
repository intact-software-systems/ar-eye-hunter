import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { toBrowserSessionALRuntimeStoreIds } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { toALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

export interface DeleteEndedSessionALRuntimeEntriesInput {
    /** The one database purged where the browser cannot list its databases. */
    readonly currentScope: StateScope;
    readonly diagnosticsPorts: RallarDiagnosticsPorts;
}

/**
 * A failed purge leaves rows behind but never keeps the session from ending. The ended session's
 * stores are gone, so no per-store health holder could report a recovery: each store id gets one
 * failing event straight on the storage port instead. A failure that is not one of storage leaves
 * `lastFailure` absent, so it is logged.
 */
export async function deleteEndedSessionALRuntimeEntries(
    sessionId: string,
    input: DeleteEndedSessionALRuntimeEntriesInput
): Promise<void> {
    const { storage } = input.diagnosticsPorts;
    try {
        await deleteBrowserALRuntimeEntriesForSession(sessionId, {
            currentScope: input.currentScope,
            storage
        });
    }
    catch (caught) {
        const error = toError(caught);
        const lastFailure = toALStorageUnavailable(error);
        if (lastFailure === undefined) {
            console.error('Failed to purge the ended session\'s browser AL runtime rows:', error);
        }
        for (const storeId of toBrowserSessionALRuntimeStoreIds(sessionId)) {
            storage({
                kind: 'health',
                storeId,
                status: 'failing',
                lastFailure,
                lastRecoveryPointAtMs: undefined,
                oldestUnsavedAgeMs: undefined
            });
        }
    }
}
