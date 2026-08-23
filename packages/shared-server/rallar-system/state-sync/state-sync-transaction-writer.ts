import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries,
    type ComputedClientStateSync,
    type ComputedGroupStateSync
} from './state-sync-entry-computation.ts';

export async function writeClientStateSync(
    transaction: PSqlTransactionSql,
    computed: ComputedClientStateSync,
    senderId: string
): Promise<readonly ResourceEntry[]> {
    const entries = computeClientStateSyncEntries(computed, senderId);
    await writeStateSyncEntries(transaction, entries);
    return entries;
}

export async function writeGroupStateSync(
    transaction: PSqlTransactionSql,
    computed: ComputedGroupStateSync,
    senderId: string
): Promise<readonly ResourceEntry[]> {
    const entries = computeGroupStateSyncEntries(computed, senderId);
    await writeStateSyncEntries(transaction, entries);
    return entries;
}

async function writeStateSyncEntries(
    transaction: PSqlTransactionSql,
    entries: readonly ResourceEntry[]
): Promise<void> {
    const repository = new ResourceInboxRepository(transaction);
    for (const entry of entries) {
        if (entry.typeId !== EnqueuedType.WS_OUTBOX) {
            throw new TypeError('State sync write received a non-WS_OUTBOX entry');
        }
        await repository.writeIfAbsentOrMatch(entry);
    }
}
