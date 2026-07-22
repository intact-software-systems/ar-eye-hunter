import { describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry,
} from '@shared/queuebox/ResourceEntry.ts';

describe('InMemoryQueueBox', () => {
    it('returns the existing entry from enqueueIfAbsent without overwriting it', async () => {
        const queue = new InMemoryQueueBox();
        const original = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 1 }),
        });
        const replacement = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 2 }),
        });

        expect(await queue.enqueueIfAbsent(original)).toBe(original);
        expect(await queue.enqueueIfAbsent(replacement)).toBe(original);

        const reserved = await queue.reserveEntries(
            new Set([original.typeId]),
            new Set([EntityStatus.NEW]),
            1,
        );

        expect(firstValue(reserved).resource).toBe(original.resource);
    });

    it('uses enqueueIf predicate to decide whether active entries are overwritten', async () => {
        const queue = new InMemoryQueueBox();
        const original = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 1 }),
        });
        const skippedReplacement = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 2 }),
        });
        const acceptedReplacement = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 3 }),
        });

        await queue.enqueueIfAbsent(original);

        const skip = vi.fn(() => false);
        expect(await queue.enqueueIf(skippedReplacement, skip)).toBe(original);
        expect(skip).toHaveBeenCalledWith(original);
        expect((await queue.getItem(original.key))?.resource).toBe(original.resource);

        const overwrite = vi.fn(() => true);
        expect(await queue.enqueueIf(acceptedReplacement, overwrite)).toBe(original);
        expect(overwrite).toHaveBeenCalledWith(original);
        expect((await queue.getItem(original.key))?.resource).toBe(acceptedReplacement.resource);
    });

    it('overwrites expired entries with enqueueIf without calling the predicate', async () => {
        const queue = new InMemoryQueueBox();
        const expired = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 1 }),
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        });
        const replacement = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 2 }),
        });
        const enqueueIt = vi.fn(() => false);

        await queue.enqueue(expired);

        expect(await queue.enqueueIf(replacement, enqueueIt)).toBeUndefined();
        expect(enqueueIt).not.toHaveBeenCalled();
        expect((await queue.getItem(expired.key))?.resource).toBe(replacement.resource);
    });

    it('removes completed entries during cleanup while keeping active work', async () => {
        const queue = new InMemoryQueueBox();

        await queue.enqueue(
            createEntry('chat.message.v1', 'completed-1', {
                status: EntityStatus.COMPLETED,
            }),
        );
        await queue.enqueue(createEntry('chat.message.v1', 'active-1'));

        expect(queue.cleanup()).toBe(true);

        const completed = await queue.reserveEntries(
            new Set(['chat.message.v1']),
            new Set([EntityStatus.COMPLETED]),
            10,
        );
        const active = await queue.reserveEntries(
            new Set(['chat.message.v1']),
            new Set([EntityStatus.NEW]),
            10,
        );

        expect(completed.size).toBe(0);
        expect(active.size).toBe(1);
    });

    it('treats expired entries as absent work and removes them during cleanup', async () => {
        const queue = new InMemoryQueueBox();
        const expiresAt = Temporal.Now.instant().subtract({ seconds: 1 });

        await queue.enqueue(
            createEntry('chat.message.v1', 'expired-1', {
                expiryTs: expiresAt,
            }),
        );
        await queue.enqueue(createEntry('chat.message.v1', 'active-1'));

        expect(
            await queue.getItem({
                topicId: 'chat.message.v1',
                resourceId: 'expired-1',
                contextId: 'ctx-1',
            }),
        ).toBeUndefined();
        expect(await queue.deleteExpired()).toBe(0);

        const active = await queue.reserveEntries(
            new Set(['chat.message.v1']),
            new Set([EntityStatus.NEW]),
            10,
        );

        expect(active.size).toBe(1);
    });

    it('applies the exact millisecond delay when retry entries are released', async () => {
        const queue = new InMemoryQueueBox();
        const entry = createEntry('chat.private-text.v1', 'retry-1', {
            status: EntityStatus.RESERVED,
            attempts: 1,
        });

        const released = firstValue(
            await queue.releaseEntries([entry], EntityStatus.RETRY, 37),
        );

        expect(released.status).toBe(EntityStatus.RETRY);
        expect(released.dequeueAudit.endTs).toBeDefined();
        expect(released.dequeueAudit.nextTs).toBeDefined();

        const delayMs = released.dequeueAudit
            .endTs!.until(released.dequeueAudit.nextTs!)
            .total({ unit: 'milliseconds' });
        expect(delayMs).toBe(37);
    });
});

function createEntry(
    typeId: string,
    resourceId: string,
    options: Partial<{
        status: EntityStatus;
        attempts: number;
        resource: string;
        expiryTs: Temporal.Instant;
    }> = {},
): ResourceEntry {
    return {
        key: {
            topicId: typeId,
            resourceId,
            contextId: 'ctx-1',
        },
        resource: options.resource ?? JSON.stringify({ typeId, resourceId }),
        typeId,
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: options.expiryTs ?? NEVER_EXPIRE_TS,
        },
        status: options.status ?? EntityStatus.NEW,
        dequeueAudit: {
            attempts: options.attempts ?? 0,
        },
        db: undefined,
    };
}

function firstValue<K, V>(map: Map<K, V>): V {
    const first = map.values().next().value;
    if (first === undefined) {
        throw new Error('Expected at least one map value');
    }
    return first;
}
