import { describe, expect, it, vi } from 'vitest';

import { finishRtcTopologyWork } from '@shared-server/rallar-system/topology/replay/work/finish-rtc-topology-work.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { createAppInboxTestDatabase } from '../../../app-inbox/test-support/app-inbox-test-database.ts';
import { createRtcTopologyReplayFixture } from '../consumer/rtc-topology-replay-fixture.ts';

describe('topology reservation completion', () => {
    it('captures completion time before transaction entry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const queue = new InMemoryQueueBox();
            const entry = {
                ...createRtcTopologyReplayFixture().outbox,
                status: EntityStatus.RESERVED,
                dequeueAudit: { attempts: 1 }
            };
            await queue.enqueue(entry);
            const database = createAppInboxTestDatabase(queue, { replace: async (value) => value }, {
                withTransaction: async (write) => {
                    vi.setSystemTime(2_000);
                    return await write();
                }
            });

            await finishRtcTopologyWork(database, entry);

            const completed = await queue.getItem(entry.key);
            expect(completed?.status).toBe(EntityStatus.COMPLETED);
            expect(completed?.dequeueAudit.endTs?.epochMilliseconds).toBe(1_000);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('does not inspect the reservation source after transaction entry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const queue = new InMemoryQueueBox();
            const entry = {
                ...createRtcTopologyReplayFixture().outbox,
                status: EntityStatus.RESERVED,
                dequeueAudit: { attempts: 1 }
            };
            const originalKey = { ...entry.key };
            await queue.enqueue(entry);
            const source = { ...entry, key: { ...entry.key } };
            const database = createAppInboxTestDatabase(queue, { replace: async (value) => value }, {
                withTransaction: async (write) => {
                    Object.assign(source.key, { resourceId: 'mutated-after-transaction-entry' });
                    return await write();
                }
            });

            await finishRtcTopologyWork(database, source);

            await expect(queue.getItem(originalKey)).resolves.toMatchObject({
                status: EntityStatus.COMPLETED,
                key: originalKey
            });
        }
        finally {
            vi.useRealTimers();
        }
    });
});
