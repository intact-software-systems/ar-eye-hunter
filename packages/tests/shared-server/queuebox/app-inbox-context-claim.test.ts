import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { hasAdvertisedDequeueWork } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createQueueResilience } from '../../shared/app-inbox/fair-service-fixture.ts';
import {
    createResourceInboxTestStorage,
    seedResourceInboxRow,
    type ResourceInboxTestStorage
} from './resource-inbox-test-storage.ts';

const HANDLER_MS = 50;
const BACKLOG = 15;

let storage: ResourceInboxTestStorage | undefined;

afterEach(async () => {
    await storage?.close();
    storage = undefined;
});

describe.each(['memory', 'pglite'] as const)('AppInbox context claim on %s storage', (backend) => {
    it('serves an idle context ahead of another context\'s backlog and keeps each context in order', async () => {
        const reader = new InboxQueueReader(await createQueue(backend), { laneBudgetPolicy: 'adaptive-retry', newLaneConcurrency: 1, nowEpochMs: Date.now });
        const completed: string[] = [];
        reader.onInboxMessageDo('test.context-claim', {
            onMessage: async (message) => {
                await new Promise((resolve) => setTimeout(resolve, HANDLER_MS));
                completed.push(message.route.resourceId);
            }
        });
        for (let index = 0; index < BACKLOG; index += 1) {
            await reader.enqueueIfAbsent(createContextMessage('user-a', `a-${index}`));
        }
        await reader.enqueueIfAbsent(createContextMessage('room-b', 'b-0'));

        const passes = await drain(reader);

        expect(completed).toHaveLength(BACKLOG + 1);
        expect(completed.indexOf('b-0'), `completion order ${completed.join(',')}`).toBeLessThan(completed.indexOf('a-2'));
        expect(completed.filter((id) => id.startsWith('a-')))
            .toEqual(Array.from({ length: BACKLOG }, (_, index) => `a-${index}`));
        expect(passes).toBe(BACKLOG);
    }, 30_000);

    it('claims each context\'s oldest eligible row in one reservation, and in queue order without the context claim', async () => {
        const queue = await createQueue(backend);
        const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'adaptive-retry', newLaneConcurrency: 1 });
        for (const [contextId, resourceId] of [['user-a', 'a-0'], ['user-a', 'a-1'], ['room-b', 'b-0'], ['user-a', 'a-2'], ['room-c', 'c-0']]) {
            await reader.enqueueIfAbsent(createContextMessage(contextId!, resourceId!));
        }
        const request = { typeIds: InboxQueueReader.INBOX_DEQUEUE_TYPES, statusIds: new Set([EntityStatus.NEW]), reservationInput: 8 };

        const heads = await queue.reserveEntries({ ...request, contextClaim: { excludedContextIds: new Set() } });
        const rest = await queue.reserveEntries(request);

        expect([...heads.values()].map((entry) => entry.key.resourceId)).toEqual(['a-0', 'b-0', 'c-0']);
        expect([...rest.values()].map((entry) => entry.key.resourceId)).toEqual(['a-1', 'a-2']);
    });

    it('skips a context its claim excludes', async () => {
        const queue = await createQueue(backend);
        const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
        for (const [contextId, resourceId] of [['user-a', 'a-0'], ['user-a', 'a-1'], ['room-b', 'b-0'], ['room-c', 'c-0']]) {
            await reader.enqueueIfAbsent(createContextMessage(contextId!, resourceId!));
        }

        const heads = await queue.reserveEntries({
            typeIds: InboxQueueReader.INBOX_DEQUEUE_TYPES,
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 8,
            contextClaim: { excludedContextIds: new Set(['user-a']) }
        });

        expect([...heads.values()].map((entry) => entry.key.resourceId)).toEqual(['b-0', 'c-0']);
    });

    it('claims one head per NEW round and excludes the contexts the pass already served', async () => {
        const queue = await createQueue(backend);
        const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
        for (const [contextId, resourceId] of [['user-a', 'a-0'], ['user-a', 'a-1'], ['room-b', 'b-0']]) {
            await reader.enqueueIfAbsent(createContextMessage(contextId!, resourceId!));
        }
        const rounds: Array<Readonly<{ reserved: readonly string[]; excluded: readonly string[]; }>> = [];
        const reserveEntries = queue.reserveEntries.bind(queue);
        vi.spyOn(queue, 'reserveEntries').mockImplementation(async (claim) => {
            const excluded = [...(claim.contextClaim?.excludedContextIds ?? [])];
            const reserved = await reserveEntries(claim);
            if (claim.statusIds.has(EntityStatus.NEW)) {
                rounds.push({ reserved: [...reserved.values()].map((entry) => entry.key.resourceId), excluded });
            }
            return reserved;
        });
        reader.onInboxMessageDo('test.context-claim', { onMessage: async () => {} });

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());

        expect(rounds).toEqual([
            { reserved: ['a-0'], excluded: [] },
            { reserved: ['b-0'], excluded: ['user-a'] },
            { reserved: [], excluded: ['user-a', 'room-b'] }
        ]);
    });
});

async function createQueue(backend: 'memory' | 'pglite'): Promise<QueueBoxResourceEntryRepository> {
    if (backend === 'memory') {
        return new InMemoryQueueBox();
    }
    storage = await createResourceInboxTestStorage('app_inbox_context_claim');
    return new PSqlQueueBox(createPSqlResourceInboxRepository(storage.sql, () => new Date()), Temporal.Now.instant);
}

/** Engine passes as the registration runs them: a probe, then the pass it advertised; the count of passes that claimed. */
async function drain(reader: InboxQueueReader): Promise<number> {
    const resilience = createQueueResilience();
    let passes = 0;
    for (let probe = 0; probe < 4 * BACKLOG; probe += 1) {
        const advertisement = await reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        if (!hasAdvertisedDequeueWork(advertisement)) {
            return passes;
        }
        if (await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, advertisement) > 0) {
            passes += 1;
        }
    }
    throw new Error('The inbox did not drain');
}

function createContextMessage(contextId: string, resourceId: string): ALMessage {
    return newALUntargetedMessage(
        'api-v1',
        newALRoute('app-inbox.context-claim', contextId, resourceId),
        'test.context-claim',
        { resourceId },
        { ttlMs: 300_000 }
    );
}

describe('PostgreSQL oldest-per-context claim', () => {
    it('takes the row the queue order serves first in each context, and no ineligible row holds a context back', async () => {
        storage = await createResourceInboxTestStorage('app_inbox_context_head');
        const sql = storage.sql;
        await seedResourceInboxRow(sql, { resourceId: 'due-delayed', status: EntityStatus.NEW, nextInSeconds: -5 });
        await seedResourceInboxRow(sql, { resourceId: 'unscheduled', status: EntityStatus.NEW });
        await seedResourceInboxRow(sql, { resourceId: 'pending', status: EntityStatus.NEW, nextInSeconds: 60 });
        await seedResourceInboxRow(sql, { resourceId: 'expired', status: EntityStatus.NEW, expired: true });
        await seedResourceInboxRow(sql, { resourceId: 'live', status: EntityStatus.NEW });
        await sql`update resource_inbox set fk_ext_bank_id = 'context-2' where ri_resource_id in ('expired', 'live')`;
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);

        const heads = await queue.reserveEntries({
            typeIds: InboxQueueReader.INBOX_DEQUEUE_TYPES,
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 8,
            contextClaim: { excludedContextIds: new Set() }
        });

        expect([...heads.values()].map((entry) => entry.key.resourceId)).toEqual(['unscheduled', 'live']);
    });
});
