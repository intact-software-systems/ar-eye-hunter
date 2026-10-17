import { expect, it } from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';

import { createCheckpointTestEntry } from '../alm/checkpoint/checkpoint-test-entry.ts';

it('publishes release only after every selected entry has its final value', async () => {
    const queue = new InMemoryQueueBox();
    const first = createCheckpointTestEntry('first');
    const second = createCheckpointTestEntry('second');
    await queue.enqueue(first);
    await queue.enqueue(second);
    const reserved = await queue.reserveEntries({ typeIds: new Set(['checkpoint.work']), statusIds: new Set([EntityStatus.NEW]), reservationInput: 2 });
    const views: (EntityStatus | undefined)[][] = [];
    queue.onChangeDo(() => views.push([queue.peek(toKeyAsString(first.key))?.status, queue.peek(toKeyAsString(second.key))?.status]));
    await queue.releaseEntries([...reserved.values()].map((entry) => ({ entry, disposition: { status: EntityStatus.COMPLETED, delayMs: null } })));
    expect(views).toEqual([[EntityStatus.COMPLETED, EntityStatus.COMPLETED], [EntityStatus.COMPLETED, EntityStatus.COMPLETED]]);
});
