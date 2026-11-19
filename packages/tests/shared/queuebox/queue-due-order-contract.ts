import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const CLAIM_LIMIT = 16;
const PAGE_SIZE = 16;
const LATER_SECONDS = 2;

interface DueOrderRow {
    readonly resourceId: string;
    readonly typeId: string;
    readonly status: EntityStatus;
    /** Seconds from now; null writes a row with no next time. */
    readonly dueInSeconds: number | null;
    readonly expired: boolean;
}

interface DueOrderScope {
    readonly queue: QueueBoxResourceEntryRepository;
    readonly typeA: string;
    readonly typeB: string;
    readonly written: ResourceEntry[];
}

/**
 * The due order every store's claim and `due` page follow (`resource-inbox-claim-order.ts`), stated here on its own
 * so that no store's helper decides what the store is checked against. Ties and rows with no next time fall to the
 * store's arrival order, so no case asserts an order among them.
 */
function toRuleDueOrder(rows: readonly ResourceEntry[], now: Temporal.Instant): ResourceEntry[] {
    const isDue = (row: ResourceEntry): boolean => row.dequeueAudit.nextTs === undefined || Temporal.Instant.compare(row.dequeueAudit.nextTs, now) <= 0;
    const isLive = (row: ResourceEntry): boolean => Temporal.Instant.compare(now, row.audit.expiryTs) < 0;
    const nextMs = (row: ResourceEntry): number => row.dequeueAudit.nextTs?.epochMilliseconds ?? Number.MIN_SAFE_INTEGER;
    return rows.filter((row) => isDue(row) && isLive(row)).sort((left, right) => nextMs(left) - nextMs(right));
}

export function toResourceIds(rows: Iterable<ResourceEntry>): string[] {
    return [...rows].map((row) => row.key.resourceId);
}

function toRowEntry(row: DueOrderRow, now: Temporal.Instant): ResourceEntry {
    const createdAt = now.toZonedDateTimeISO('UTC');
    const nextTs = row.dueInSeconds === null ? undefined : now.add({ milliseconds: row.dueInSeconds * 1_000 });
    const lastAttempt = { startTs: now.subtract({ minutes: 5 }), endTs: now.subtract({ minutes: 4 }) };
    return {
        key: { topicId: 'due-order', resourceId: row.resourceId, contextId: 'due-order-context' },
        typeId: row.typeId,
        resource: row.resourceId,
        status: row.status,
        audit: {
            date: createdAt.toPlainTime(),
            createdBy: 'due-order',
            createdTs: createdAt.toPlainDateTime(),
            expiryTs: row.expired ? now.subtract({ seconds: 1 }) : NEVER_EXPIRE_TS
        },
        dequeueAudit: row.status === EntityStatus.RETRY
            ? { ...lastAttempt, nextTs, attempts: 1 }
            : { nextTs, attempts: 0 },
        db: undefined
    };
}

async function createScope(createQueue: () => Promise<QueueBoxResourceEntryRepository>): Promise<DueOrderScope> {
    return { queue: await createQueue(), typeA: 'due-order-a', typeB: 'due-order-b', written: [] };
}

async function writeRows(scope: DueOrderScope, rows: readonly DueOrderRow[]): Promise<void> {
    const now = Temporal.Now.instant();
    for (const row of rows) {
        const entry = toRowEntry(row, now);
        await scope.queue.enqueue(entry);
        scope.written.push(entry);
    }
}

function newRow(scope: DueOrderScope, resourceId: string, dueInSeconds: number | null): DueOrderRow {
    return { resourceId, typeId: scope.typeA, status: EntityStatus.NEW, dueInSeconds, expired: false };
}

export interface DueClaim {
    readonly typeIds: Set<string>;
    readonly maxToReserve: number;
    readonly excludedContextIds?: ReadonlySet<string>;
}

/** A due claim: the pending statuses of `typeIds`, at most `maxToReserve` rows. */
export async function claimDue(queue: QueueBoxResourceEntryRepository, claim: DueClaim): Promise<ResourceEntry[]> {
    const claimed = await queue.reserveEntries({
        typeIds: claim.typeIds,
        statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
        reservationInput: claim.maxToReserve,
        contextClaim: claim.excludedContextIds === undefined ? undefined : { excludedContextIds: claim.excludedContextIds }
    });
    return [...claimed.values()];
}

async function claimDueOfScope(scope: DueOrderScope): Promise<ResourceEntry[]> {
    return await claimDue(scope.queue, { typeIds: new Set([scope.typeA, scope.typeB]), maxToReserve: CLAIM_LIMIT });
}

export function toDueIds(count: number, prefix: string): string[] {
    return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')}`);
}

/** `createQueue` answers a new, empty queue for every case. */
export function describeQueueDueOrderContract(
    storeName: string,
    createQueue: () => Promise<QueueBoxResourceEntryRepository>
): void {
    describe(`the due order of the ${storeName} queue`, () => {
        it('a claim takes the rows that are due although a full claim of rows due later sorts before them', async () => {
            const scope = await createScope(createQueue);
            await writeRows(scope, [
                ...toDueIds(20, 'a').map((id) => newRow(scope, id, LATER_SECONDS)),
                ...['z-0', 'z-1', 'z-2'].map((id) => newRow(scope, id, 0))
            ]);

            const claimedAt = Temporal.Now.instant();
            const claimed = await claimDueOfScope(scope);

            const expected = toRuleDueOrder(scope.written, claimedAt).slice(0, CLAIM_LIMIT);
            expect(toResourceIds(claimed).sort()).toEqual(toResourceIds(expected).sort());
        });

        it('a claim takes the earliest rows first', async () => {
            const scope = await createScope(createQueue);
            await writeRows(scope, [newRow(scope, 'c', -20), newRow(scope, 'b', -30), newRow(scope, 'a', -10)]);

            const claimed = await scope.queue.reserveEntries({
                typeIds: new Set([scope.typeA]),
                statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
                reservationInput: 2
            });

            const expected = toRuleDueOrder(scope.written, Temporal.Now.instant()).slice(0, 2);
            expect(toResourceIds(claimed.values())).toEqual(toResourceIds(expected));
        });

        it('a claim\'s bound is a total across statuses and types', async () => {
            const scope = await createScope(createQueue);
            await writeRows(scope, [
                ...toDueIds(10, 'a').map((id, index): DueOrderRow => newRow(scope, id, -22 - 2 * index)),
                ...toDueIds(10, 'b').map((id, index): DueOrderRow => ({
                    resourceId: id,
                    typeId: scope.typeB,
                    status: EntityStatus.RETRY,
                    dueInSeconds: -21 - 2 * index,
                    expired: false
                }))
            ]);

            const claimed = await claimDueOfScope(scope);

            const expected = toRuleDueOrder(scope.written, Temporal.Now.instant()).slice(0, CLAIM_LIMIT);
            expect(toResourceIds(claimed)).toEqual(toResourceIds(expected));
        });

        it('a row due exactly now is claimed', async () => {
            const scope = await createScope(createQueue);
            await writeRows(scope, [newRow(scope, 'now', 0)]);

            const claimed = await claimDueOfScope(scope);

            expect(toResourceIds(claimed)).toEqual(toResourceIds(toRuleDueOrder(scope.written, Temporal.Now.instant())));
        });

        it('a due page holds the earliest rows', async () => {
            const scope = await createScope(createQueue);
            await writeRows(scope, [
                ...toDueIds(20, 'a').map((id) => newRow(scope, id, LATER_SECONDS)),
                newRow(scope, 'z-due', 0)
            ]);

            const readAt = Temporal.Now.instant();
            const page = await scope.queue.readWorkPage({
                typeId: scope.typeA,
                status: EntityStatus.NEW,
                maxToRead: PAGE_SIZE,
                order: 'due',
                cursor: null
            });

            const [earliest] = toRuleDueOrder(scope.written, readAt);
            expect({ first: page.entries[0]?.key.resourceId, nextCursor: page.nextCursor })
                .toEqual({ first: earliest.key.resourceId, nextCursor: null });
        });

        it('a due page reads past expired rows that are due before a live row', async () => {
            const scope = await createScope(createQueue);
            await writeRows(scope, [
                ...toDueIds(PAGE_SIZE + 4, 'a').map((id, index): DueOrderRow => ({ ...newRow(scope, id, -60 + index), expired: true })),
                newRow(scope, 'z-live', -1)
            ]);

            const page = await scope.queue.readWorkPage({
                typeId: scope.typeA,
                status: EntityStatus.NEW,
                maxToRead: PAGE_SIZE,
                order: 'due',
                cursor: null
            });

            expect(toResourceIds(page.entries)).toEqual(toResourceIds(toRuleDueOrder(scope.written, Temporal.Now.instant())));
        });

        it('a key page pages with its cursor as before', async () => {
            const scope = await createScope(createQueue);
            await writeRows(scope, toDueIds(21, 'k').map((id) => newRow(scope, id, LATER_SECONDS)));
            const request = {
                typeId: scope.typeA,
                status: EntityStatus.NEW,
                maxToRead: PAGE_SIZE,
                order: 'key',
                cursor: null
            } as const;

            const first = await scope.queue.readWorkPage(request);
            const second = await scope.queue.readWorkPage({ ...request, cursor: first.nextCursor });

            const read = toResourceIds([...first.entries, ...second.entries]);
            expect([first.entries.length, second.entries.length, second.nextCursor]).toEqual([PAGE_SIZE, 5, null]);
            expect(read.toSorted()).toEqual(toResourceIds(scope.written).toSorted());
        });

        it('a row enqueued with no next time is claimed as due', async () => {
            const scope = await createScope(createQueue);
            await writeRows(scope, [newRow(scope, 'undated', null), newRow(scope, 'later', LATER_SECONDS)]);

            const claimed = await claimDueOfScope(scope);

            expect(toResourceIds(claimed)).toEqual(toResourceIds(toRuleDueOrder(scope.written, Temporal.Now.instant())));
        });

        it('expired rows that are due do not keep live due rows out', async () => {
            const scope = await createScope(createQueue);
            await writeRows(scope, [
                ...toDueIds(16, 'a').map((id, index): DueOrderRow => ({ ...newRow(scope, id, -60 + index), expired: true })),
                newRow(scope, 'z-live', -1)
            ]);

            const claimed = await claimDueOfScope(scope);

            expect(toResourceIds(claimed)).toEqual(toResourceIds(toRuleDueOrder(scope.written, Temporal.Now.instant())));
        });
    });
}
