import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries,
    type ComputedClientStateSync,
    type ComputedGroupStateSync
} from './state-sync-entry-computation.ts';

export async function writeClientStateSync(
    transaction: PSqlSql,
    computed: ComputedClientStateSync,
    senderId: string
): Promise<readonly ResourceEntry[]> {
    const entries = computeClientStateSyncEntries(computed, senderId);
    await writeStateSyncEntries(transaction, entries);
    return entries;
}

export async function writeGroupStateSync(
    transaction: PSqlSql,
    computed: ComputedGroupStateSync,
    senderId: string
): Promise<readonly ResourceEntry[]> {
    const entries = computeGroupStateSyncEntries(computed, senderId);
    await writeStateSyncEntries(transaction, entries);
    return entries;
}

async function writeStateSyncEntries(
    transaction: PSqlSql,
    entries: readonly ResourceEntry[]
): Promise<void> {
    const repository = new PSqlResourceInboxEntryRepository(transaction);
    for (const entry of entries) {
        if (entry.typeId !== EnqueuedType.WS_OUTBOX) {
            throw new TypeError('State sync write received a non-WS_OUTBOX entry');
        }
        await repository.writeIfAbsentOrMatch(entry);
    }
}
