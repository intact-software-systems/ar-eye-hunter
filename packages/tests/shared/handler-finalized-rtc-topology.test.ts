// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/IndexedDbQueueBox.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

type ReleaseAdapter = Readonly<{
    name: string;
    release(
        reserved: ResourceEntry,
        current: ResourceEntry
    ): Promise<ResourceEntry>;
}>;

const ADAPTERS: readonly ReleaseAdapter[] = [
    {
        name: 'in-memory',
        release: async (reserved, current) => {
            const queue = new InMemoryQueueBox();
            await queue.enqueue(current);
            return firstValue(
                await queue.releaseEntries([reserved], {
                    status: EntityStatus.COMPLETED,
                    delayMs: null
                })
            );
        }
    },
    {
        name: 'IndexedDB',
        release: async (reserved, current) => {
            const queue = new IndexedDbQueueBox({
                dbName: `indexeddb-rtc-finalized-${crypto.randomUUID()}`
            });
            await queue.enqueue(current);
            return firstValue(
                await queue.releaseEntries([reserved], {
                    status: EntityStatus.COMPLETED,
                    delayMs: null
                })
            );
        }
    },
    {
        name: 'PostgreSQL',
        release: async (reserved, current) => {
            const transactionRepository = {
                releaseReserved: vi.fn(async () => null),
                findAnyByKey: vi.fn(async () => current)
            };
            const repository = {
                begin: vi.fn(async (fn: (value: unknown) => Promise<unknown>) => await fn(transactionRepository))
            };
            const queue = new PSqlQueueBox(repository as never);
            return firstValue(
                await queue.releaseEntries([reserved], {
                    status: EntityStatus.COMPLETED,
                    delayMs: null
                })
            );
        }
    }
];

describe.each(ADAPTERS)('$name handler-finalized RTC topology release', ({ release }) => {
    it('accepts the exact canonical entry completed atomically by its handler', async () => {
        const reserved = createReservedRtcTopologyEntry();
        const current = complete(reserved);

        expect(await release(reserved, current)).toMatchObject({
            key: current.key,
            resource: current.resource,
            status: EntityStatus.COMPLETED
        });
    });

    it('rejects a different immutable RTC topology entry', async () => {
        const reserved = createReservedRtcTopologyEntry();
        const current = {
            ...complete(reserved),
            resource: reserved.resource.replace('group-revision', 'rtt-refresh')
        };

        await expect(release(reserved, current)).rejects.toMatchObject({
            code: 'resource-inbox-lost-reservation'
        });
    });
});

function createReservedRtcTopologyEntry(): ResourceEntry {
    const createdAtEpochMs = 1_000;
    const expireAtEpochMs = 253_402_300_799_999;
    const key = {
        topicId: 'app-outbox.rtc-topology',
        resourceId: 'rtc-work-1',
        contextId: 'rtc-group-1'
    };
    const senderId = 'rallar-server';
    const envelope = {
        type: 'RTC_TOPOLOGY_RECOMPUTE',
        topicId: key.topicId,
        resourceId: key.resourceId,
        contextId: key.contextId,
        senderId,
        data: {
            kind: 'group-revision',
            overlayId: '["app","workspace","group"]'
        }
    };
    const message = {
        id: { v: 2, msgId: key.resourceId, ts: createdAtEpochMs, senderId },
        route: key,
        constraints: { expiresAtMs: expireAtEpochMs },
        payload: {
            typeId: 'RTC_TOPOLOGY_RECOMPUTE',
            contentType: 'application/json',
            resource: JSON.stringify(envelope)
        },
        audit: { createdBy: senderId, createdTs: createdAtEpochMs }
    };
    const createdTs = Temporal.Instant.fromEpochMilliseconds(createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.APP_OUTBOX,
        status: EntityStatus.RESERVED,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: senderId,
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(expireAtEpochMs)
        },
        dequeueAudit: {
            attempts: 2,
            startTs: Temporal.Instant.fromEpochMilliseconds(1_050)
        }
    };
}

function complete(entry: ResourceEntry): ResourceEntry {
    return {
        ...entry,
        status: EntityStatus.COMPLETED,
        dequeueAudit: {
            ...entry.dequeueAudit,
            endTs: Temporal.Instant.fromEpochMilliseconds(1_100)
        }
    };
}

function firstValue<T>(values: Map<unknown, T>): T {
    const value = values.values().next().value;
    if (!value) {
        throw new Error('Expected one released entry');
    }
    return value;
}
