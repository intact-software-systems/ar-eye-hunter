import 'fake-indexeddb/auto';
import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import type { PSqlParameter } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlResourceInboxReservationRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-reservation-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from './resource-inbox-test-storage.ts';

let storage: ResourceInboxTestStorage | undefined;
afterEach(async () => {
    await storage?.close();
    storage = undefined;
});
const TYPES = new Set(['APP_INBOX']);
const SUPPORTED = new Set(['app:stock:reserve']);
const WORK = { maxAttempts: 20, finalizationStaleAfterMs: 1000, reservationLeaseMs: 1000, staleDueThresholdMs: 30000 };

describe.each(['memory', 'indexeddb', 'sql'] as const)('topic eligibility on %s', (backend) => {
    it.each(['NEW', 'RETRY', 'FAIRNESS', 'TIMEOUT', 'FINALIZATION'] as const)('does not reserve or advertise unsupported %s work', async (lane) => {
        const queue = await createQueue(backend);
        const unsupported = createEntry('app:other:reserve', lane);
        await queue.enqueue(unsupported);
        const before = await queue.getItem(unsupported.key);
        const absent = await queue.readWorkAdvertisement(TYPES, { ...WORK, allowedTopicIds: SUPPORTED });
        expect(absent).toEqual({ NEW: false, RETRY: false, FAIRNESS: false, TIMEOUT: false, FINALIZATION: false });
        expect((await claim(queue, lane, SUPPORTED)).size).toBe(0);
        expect(await queue.getItem(unsupported.key)).toEqual(before);
        const supported = createEntry('app:stock:reserve', lane);
        await queue.enqueue(supported);
        const [empty, present] = await Promise.all([
            queue.readWorkAdvertisement(TYPES, { ...WORK, allowedTopicIds: new Set() }),
            queue.readWorkAdvertisement(TYPES, { ...WORK, allowedTopicIds: SUPPORTED })
        ]);
        expect(Object.values(empty).some(Boolean)).toBe(false);
        expect(present[lane]).toBe(true);
        expect((await claim(queue, lane, new Set())).size).toBe(0);
        expect(await queue.getItem(supported.key)).toMatchObject({ status: supported.status, dequeueAudit: supported.dequeueAudit });
        expect([...await claim(queue, lane, SUPPORTED)].map(([, value]) => 'entry' in value ? value.entry.key.topicId : value.key.topicId))
            .toEqual(['app:stock:reserve']);
        expect(await queue.getItem(unsupported.key)).toEqual(before);
        expect((await claim(queue, lane, undefined)).size).toBe(1);
    });

    it('claims the first supported context head behind an unsupported older row', async () => {
        const queue = await createQueue(backend);
        await queue.enqueue(createEntry('app:other:reserve', 'NEW'));
        await queue.enqueue(createEntry('app:stock:reserve', 'NEW'));
        const heads = await queue.reserveEntries({
            typeIds: TYPES,
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: { maxToReserve: 1, maxAttempts: 20, allowedTopicIds: SUPPORTED },
            contextClaim: { excludedContextIds: new Set() }
        });
        expect([...heads.values()].map((entry) => entry.key.topicId)).toEqual(['app:stock:reserve']);
    });

    it('reads past unsupported pages to advertise and reserve later supported work', async () => {
        const queue = await createQueue(backend);
        for (let index = 0; index < 270; index += 1) {
            const entry = createEntry('app:other:reserve', 'NEW');
            await queue.enqueue({ ...entry, key: { ...entry.key, resourceId: `unsupported-${index}` } });
        }
        const supported = createEntry('app:stock:reserve', 'NEW');
        await queue.enqueue(supported);
        expect((await queue.readWorkAdvertisement(TYPES, { ...WORK, allowedTopicIds: SUPPORTED })).NEW).toBe(true);
        const selected = await claim(queue, 'NEW', SUPPORTED);
        expect([...selected.values()].map((value) => 'entry' in value ? value.entry.key.topicId : value.key.topicId)).toEqual(['app:stock:reserve']);
    });

    it('observed reservation does not claim unsupported observations', async () => {
        const queue = await createQueue(backend);
        const unsupported = createEntry('app:other:reserve', 'NEW');
        await queue.enqueue(unsupported);
        const observed = (await queue.getItem(unsupported.key))!;
        expect(
            (await queue.reserveEntries({
                typeIds: TYPES,
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: { maxToReserve: 1, maxAttempts: 20, allowedTopicIds: SUPPORTED },
                observedEntries: [observed]
            })).size
        ).toBe(0);
        expect(await queue.getItem(unsupported.key)).toEqual(observed);
    });
});

// The SQL port must not serialize/transmit the same topic inventory for every lane and context probe.
it('binds one topic inventory per SQL operation while preserving exact topic and context selection', async () => {
    storage = await createResourceInboxTestStorage('topic_binding');
    const topics = new Set(Array.from({ length: 65 }, (_, index) => `app:stock:${index},"\\{}'`));
    const boundTopicCounts: number[] = [];
    const sql = new Proxy(storage.sql, {
        apply(target, receiver, args: PSqlParameter[]) {
            if (Array.isArray(args[0]) && Object.hasOwn(args[0], 'raw')) {
                boundTopicCounts.push(args.slice(1).flatMap((value) => Array.isArray(value) ? value : [value])
                    .filter((value) => typeof value === 'string' && topics.has(value)).length);
            }
            return Reflect.apply(target, receiver, args);
        }
    });
    const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);
    const foreign = createEntry('app:other:reserve', 'NEW');
    const supported = createEntry(`app:stock:64,"\\{}'`, 'NEW');
    await queue.enqueue(foreign);
    await queue.enqueue(supported);
    boundTopicCounts.length = 0;
    expect((await queue.readWorkAdvertisement(TYPES, { ...WORK, allowedTopicIds: topics })).NEW).toBe(true);
    expect(boundTopicCounts).toEqual([65]);
    boundTopicCounts.length = 0;
    const reservations = new PSqlResourceInboxReservationRepository(sql);
    const selected = await reservations.reserveEntriesSkipLocked({
        typeIds: TYPES,
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: { maxToReserve: 1, maxAttempts: 20, allowedTopicIds: topics },
        contextClaim: { excludedContextIds: new Set() }
    });
    expect([...selected.values()].map((entry) => entry.key.topicId)).toEqual([supported.key.topicId]);
    expect(boundTopicCounts).toEqual([65]);
    expect(await queue.getItem(foreign.key)).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
});

it('an observed IndexedDB claim does not sweep an unsupported row that expired after observation', async () => {
    let now = Temporal.Now.instant();
    const queue = new IndexedDbQueueBox({
        dbName: `topic-selection-expired-${crypto.randomUUID()}`,
        now: () => now,
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const unsupported = createEntry('app:other:reserve', 'NEW');
    await queue.enqueue(unsupported);
    const observed = (await queue.getItem(unsupported.key))!;
    now = now.add({ hours: 1 });
    await queue.reserveEntries({
        typeIds: TYPES,
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: { maxToReserve: 1, maxAttempts: 20, allowedTopicIds: SUPPORTED },
        observedEntries: [observed]
    });
    expect(queue.getReservationExpiredDeleteCount(undefined)).toBe(0);
});

async function createQueue(backend: 'memory' | 'indexeddb' | 'sql'): Promise<QueueBoxResourceEntryRepository> {
    if (backend === 'memory') {
        return new InMemoryQueueBox();
    }
    if (backend === 'indexeddb') {
        return new IndexedDbQueueBox({ dbName: `topic-selection-${crypto.randomUUID()}`, observer: createPassThroughIndexedDbOperationObserver() });
    }
    storage = await createResourceInboxTestStorage('topic_selection');
    return new PSqlQueueBox(createPSqlResourceInboxRepository(storage.sql, () => new Date()), Temporal.Now.instant);
}

function createEntry(topic: string, lane: string): ResourceEntry {
    const now = Temporal.Now.instant();
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(
        newALUntargetedMessage('test', newALRoute(topic, 'same-context', lane), topic, {}, { ttlMs: 300000 }),
        'APP_INBOX',
        now.subtract({ seconds: 90 })
    );
    return {
        ...entry,
        status: lane === 'NEW' ? EntityStatus.NEW : lane === 'RETRY' || lane === 'FAIRNESS' ? EntityStatus.RETRY : EntityStatus.RESERVED,
        dequeueAudit: {
            attempts: lane === 'FINALIZATION' ? 20 : lane === 'NEW' ? 0 : 1,
            startTs: lane === 'NEW' ? undefined : now.subtract({ seconds: 80 }),
            endTs: lane === 'RETRY' || lane === 'FAIRNESS' ? now.subtract({ seconds: 70 }) : undefined,
            nextTs: lane === 'RETRY' || lane === 'FAIRNESS' ? now.subtract({ seconds: 60 }) : undefined
        }
    };
}

async function claim(queue: QueueBoxResourceEntryRepository, lane: string, allowedTopicIds: ReadonlySet<string> | undefined) {
    const options = { maxToReserve: 1, maxAttempts: 20, allowedTopicIds };
    if (lane === 'FINALIZATION') {
        return await queue.reserveRetryExhaustionFinalizations(TYPES, { ...options, processingAttempts: 20, staleAfterMs: 1000 });
    }
    if (lane === 'TIMEOUT') {
        return await queue.reserveTimeoutEntries({ typeIds: TYPES, reservationInput: options, timeSinceStartTs: Temporal.Duration.from({ seconds: 1 }) });
    }
    if (lane === 'FAIRNESS') {
        return await queue.reserveOverdueRetryEntries(TYPES, Date.now() - 30000, { ...options, maxToScan: 8 });
    }
    return await queue.reserveEntries({
        typeIds: TYPES,
        statusIds: new Set([lane === 'NEW' ? EntityStatus.NEW : EntityStatus.RETRY]),
        reservationInput: options
    });
}
