import { expect, it } from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    claimDue,
    createDueEntry,
    describeQueueDueOrderBrowserStoreCases,
    describeQueueDueOrderStoreCases,
    DUE_CREATED_AT,
    DUE_NOW,
    DUE_TYPE_ID,
    toResourceIds
} from './queue-due-order-store-cases.ts';

function createQueueAt(): InMemoryQueueBox {
    return new InMemoryQueueBox(new Map(), () => DUE_NOW);
}

describeQueueDueOrderBrowserStoreCases('memory', async () => createQueueAt());
describeQueueDueOrderStoreCases('memory', async () => createQueueAt());

it('places an undated row among dated rows by its creation instant, ties in arrival order', async () => {
    const queue = createQueueAt();
    await queue.enqueue(createDueEntry('b-tie', { nextTs: DUE_CREATED_AT }));
    await queue.enqueue(createDueEntry('c-later', { nextTs: DUE_CREATED_AT.add({ seconds: 1 }) }));
    await queue.enqueue(createDueEntry('a-undated', { nextTs: undefined }));
    await queue.enqueue(createDueEntry('d-earlier', { nextTs: DUE_CREATED_AT.subtract({ seconds: 1 }) }));

    const page = await queue.readWorkPage({
        typeId: DUE_TYPE_ID,
        status: EntityStatus.NEW,
        maxToRead: 16,
        order: 'due',
        cursor: null
    });
    const claimed = await claimDue(queue, { maxToReserve: 16 });

    const expected = ['d-earlier', 'b-tie', 'a-undated', 'c-later'];
    expect({ page: toResourceIds(page.entries), claimed: toResourceIds(claimed) })
        .toEqual({ page: expected, claimed: expected });
});

it('a claim that names no RETRY still takes its rows in creation order', async () => {
    const queue = createQueueAt();
    await queue.enqueue(createDueEntry('young', { nextTs: DUE_NOW.subtract({ seconds: 30 }) }));
    await queue.enqueue(createDueEntry('old', {
        nextTs: DUE_NOW.subtract({ seconds: 10 }),
        createdAt: DUE_CREATED_AT.subtract({ seconds: 5 })
    }));

    const claimed = await queue.reserveEntries({
        typeIds: new Set([DUE_TYPE_ID]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: 1
    });

    expect(toResourceIds(claimed.values())).toEqual(['old']);
});
