import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export const DUE_TYPE_ID = 'due.order.v1';
/** Sub-millisecond, so a row one nanosecond later shares a millisecond index and only the instant decides. */
export const DUE_NOW = Temporal.Instant.from('2026-11-18T12:00:00.000000500Z');
export const DUE_CREATED_AT = DUE_NOW.subtract({ minutes: 1 }).round({
    smallestUnit: 'millisecond',
    roundingMode: 'floor'
});

export interface DueEntryOptions {
    readonly nextTs: Temporal.Instant | undefined;
    readonly contextId?: string;
    readonly status?: EntityStatus;
    readonly expiryTs?: Temporal.Instant;
    readonly createdAt?: Temporal.Instant;
    readonly attempts?: number;
}

export function createDueEntry(resourceId: string, options: DueEntryOptions): ResourceEntry {
    const createdAt = (options.createdAt ?? DUE_CREATED_AT).toZonedDateTimeISO('UTC');
    const status = options.status ?? EntityStatus.NEW;
    return {
        key: { topicId: DUE_TYPE_ID, resourceId, contextId: options.contextId ?? 'ctx-1' },
        resource: resourceId,
        typeId: DUE_TYPE_ID,
        audit: {
            date: createdAt.toPlainTime(),
            createdBy: 'test',
            createdTs: createdAt.toPlainDateTime(),
            expiryTs: options.expiryTs ?? NEVER_EXPIRE_TS
        },
        status,
        dequeueAudit: {
            startTs: status === EntityStatus.RESERVED ? DUE_NOW : undefined,
            endTs: undefined,
            nextTs: options.nextTs,
            attempts: options.attempts ?? (status === EntityStatus.RESERVED ? 1 : 0)
        },
        db: undefined
    };
}

export async function claimDue(
    queue: QueueBoxResourceEntryRepository,
    claim: Readonly<{ maxToReserve: number; excludedContextIds?: ReadonlySet<string>; }>
): Promise<ResourceEntry[]> {
    const claimed = await queue.reserveEntries({
        typeIds: new Set([DUE_TYPE_ID]),
        statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
        reservationInput: claim.maxToReserve,
        contextClaim: claim.excludedContextIds === undefined ? undefined : { excludedContextIds: claim.excludedContextIds }
    });
    return [...claimed.values()];
}

export function toDueIds(count: number, prefix: string): string[] {
    return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')}`);
}

export function toResourceIds(entries: Iterable<ResourceEntry>): string[] {
    return [...entries].map((entry) => entry.key.resourceId);
}

/** `createQueueAt` answers a new, empty queue whose clock reads `DUE_NOW`. */
export type DueOrderQueueFactory = (name: string) => Promise<QueueBoxResourceEntryRepository>;

/**
 * Cases only the browser stores can be set up for: a claim clock the test sets (PostgreSQL's claims read the
 * database's clock), and pending rows that carry spent attempts (PostgreSQL refuses a NEW row with attempts as corrupt).
 */
export function describeQueueDueOrderBrowserStoreCases(storeName: string, createQueueAt: DueOrderQueueFactory): void {
    describe(`the ${storeName} queue's due order at its own clock and with spent attempts`, () => {
        it('claims a row due exactly at the store\'s now past a full claim of rows due a millisecond later', async () => {
            const queue = await createQueueAt('boundary');
            for (const id of toDueIds(16, 'a')) {
                await queue.enqueue(createDueEntry(id, { nextTs: DUE_NOW.add({ milliseconds: 1 }) }));
            }
            await queue.enqueue(createDueEntry('z-at-now', { nextTs: DUE_NOW }));
            await queue.enqueue(createDueEntry('z-after-now', { nextTs: DUE_NOW.add({ nanoseconds: 1 }) }));

            const claimed = await claimDue(queue, { maxToReserve: 16 });

            expect(toResourceIds(claimed)).toEqual(['z-at-now']);
        });

        it('reads past due rows whose attempts are spent, so they do not hide a reservable due row', async () => {
            const queue = await createQueueAt('exhausted');
            for (const [index, id] of toDueIds(16, 'a').entries()) {
                await queue.enqueue(createDueEntry(id, { nextTs: DUE_NOW.subtract({ seconds: 60 - index }), attempts: 3 }));
            }
            await queue.enqueue(createDueEntry('z-reservable', { nextTs: DUE_NOW.subtract({ seconds: 1 }) }));

            const claimed = await queue.reserveEntries({
                typeIds: new Set([DUE_TYPE_ID]),
                statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
                reservationInput: { maxToReserve: 16, maxAttempts: 3 }
            });

            expect(toResourceIds(claimed.values())).toEqual(['z-reservable']);
        });
    });
}

/** The due-order guarantees every store gives beyond the rule's contract; every row the cases claim is due by `DUE_NOW`. */
export function describeQueueDueOrderStoreCases(storeName: string, createQueueAt: DueOrderQueueFactory): void {
    describe(`the ${storeName} queue's due order beyond the contract`, () => {
        it('a context claim takes each admitted context\'s earliest due row', async () => {
            const queue = await createQueueAt('context-claim');
            await queue.enqueue(createDueEntry('a-later', { nextTs: DUE_NOW.subtract({ seconds: 10 }), contextId: 'ctx-1' }));
            await queue.enqueue(createDueEntry('b-earlier', { nextTs: DUE_NOW.subtract({ seconds: 30 }), contextId: 'ctx-1' }));
            await queue.enqueue(createDueEntry('c-only', { nextTs: DUE_NOW.subtract({ seconds: 20 }), contextId: 'ctx-2' }));
            await queue.enqueue(createDueEntry('d-excluded', { nextTs: DUE_NOW.subtract({ seconds: 40 }), contextId: 'ctx-3' }));

            const claimed = await claimDue(queue, { maxToReserve: 16, excludedContextIds: new Set(['ctx-3']) });

            expect(toResourceIds(claimed)).toEqual(['b-earlier', 'c-only']);
        });

        it('an observed claim reserves exactly the rows it observed, wherever they fall in due order', async () => {
            const queue = await createQueueAt('observed');
            for (const [index, id] of toDueIds(20, 'a').entries()) {
                await queue.enqueue(createDueEntry(id, { nextTs: DUE_NOW.subtract({ seconds: 60 - index }) }));
            }
            await queue.enqueue(createDueEntry('z-0', { nextTs: DUE_NOW.subtract({ seconds: 1 }) }));
            await queue.enqueue(createDueEntry('z-1', { nextTs: DUE_NOW.subtract({ seconds: 2 }) }));
            const observed = await Promise.all(
                ['z-0', 'z-1'].map((id) => queue.getItem(createDueEntry(id, { nextTs: DUE_NOW }).key))
            );

            const claimed = await queue.reserveEntries({
                typeIds: new Set([DUE_TYPE_ID]),
                statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
                reservationInput: 16,
                observedEntries: observed.filter((entry) => entry !== undefined)
            });

            expect(toResourceIds(claimed.values()).toSorted()).toEqual(['z-0', 'z-1']);
        });

        it('claims an undated pending row as due and reads its next time back undated', async () => {
            const queue = await createQueueAt('undated');
            const undated = createDueEntry('undated', { nextTs: undefined });
            await queue.enqueue(undated);

            const pending = await queue.getItem(undated.key);
            const claimed = await claimDue(queue, { maxToReserve: 16 });

            expect([pending?.dequeueAudit.nextTs, toResourceIds(claimed)]).toEqual([undefined, ['undated']]);
        });

        it('a due page holds expired and not-yet-due rows in due order, with no next cursor', async () => {
            const queue = await createQueueAt('due-page');
            await queue.enqueue(createDueEntry('a-later', { nextTs: DUE_NOW.add({ seconds: 2 }) }));
            await queue.enqueue(createDueEntry('b-expired', {
                nextTs: DUE_NOW.subtract({ seconds: 5 }),
                expiryTs: DUE_NOW.subtract({ seconds: 1 })
            }));
            await queue.enqueue(createDueEntry('c-due', { nextTs: DUE_NOW.subtract({ seconds: 1 }) }));

            const page = await queue.readWorkPage({
                typeId: DUE_TYPE_ID,
                status: EntityStatus.NEW,
                maxToRead: 3,
                order: 'due',
                cursor: null
            });

            expect({ ids: toResourceIds(page.entries), nextCursor: page.nextCursor })
                .toEqual({ ids: ['b-expired', 'c-due', 'a-later'], nextCursor: null });
        });

        it('refuses a due page request that carries a cursor', async () => {
            const queue = await createQueueAt('due-page-cursor');

            await expect(queue.readWorkPage({
                typeId: DUE_TYPE_ID,
                status: EntityStatus.NEW,
                maxToRead: 16,
                order: 'due',
                cursor: { typeId: DUE_TYPE_ID, status: EntityStatus.NEW, position: 'a' }
            })).rejects.toThrow(TypeError);
        });
    });
}
