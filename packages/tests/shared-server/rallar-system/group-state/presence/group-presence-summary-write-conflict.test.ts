import { describe, expect, it, vi } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { PRESENCE_SUMMARIES_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { GROUP_PRESENCE_SUMMARY_CONFLICT_RETRY_DELAY_MS } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { ResourceInboxHandlerRetryableConflict } from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';

import { createGroupDeltaProducer } from './group-delta-producer-fixture.ts';

describe('the presence summary write conflict (D304)', () => {
    it('answers a summary another server wrote first as a retryable conflict with a short flat delay, then converges on the next attempt', async () => {
        const producer = await createGroupDeltaProducer();
        const summaryKey = groupStateGroupStorageKey(producer.ref);
        const read = producer.worker.read.bind(producer.worker);
        // Another server's summary of the same group commits between this attempt's read and its write.
        const competing = vi.spyOn(producer.worker, 'read').mockImplementationOnce(async (items, nowEpochMs) => {
            const result = await read(items, nowEpochMs);
            await producer.repository.upsert(PRESENCE_SUMMARIES_NAMESPACE, summaryKey, '{"competing":true}', producer.now + 60_000);
            return result;
        });

        const outcome = await producer.worker.processReservedEntry(producer.message, producer.entry);

        expect(outcome).toBeInstanceOf(ResourceInboxHandlerRetryableConflict);
        expect(outcome).toMatchObject({
            code: 'group-presence-summary-changed',
            retryDelayMs: GROUP_PRESENCE_SUMMARY_CONFLICT_RETRY_DELAY_MS,
            entry: producer.entry
        });
        expect(GROUP_PRESENCE_SUMMARY_CONFLICT_RETRY_DELAY_MS).toBeLessThan(1_000);

        competing.mockRestore();
        // The next attempt recomputes from the fresh rows; the competing value is not a valid summary, so it is cleared.
        await producer.repository.deleteByKey(PRESENCE_SUMMARIES_NAMESPACE, summaryKey);
        await expect(producer.worker.processReservedEntry(producer.message, producer.entry)).resolves.toBeUndefined();
        const [summary] = await producer.repository.findAllEntries(PRESENCE_SUMMARIES_NAMESPACE);
        expect(summary?.key).toBe(summaryKey);
        expect(summary?.value).not.toContain('competing');
    });
});
