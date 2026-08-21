import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import { describe, expect, it, vi } from 'vitest';
import { HANDLER_FINALIZED_SUMMARY_SCENARIOS } from './handler-finalized-summary-test-support.ts';

describe('InMemoryQueueBox', () => {
    it.each(HANDLER_FINALIZED_SUMMARY_SCENARIOS)(
        'fences handler-finalized summary release: $name',
        async ({ accepted, entries }) => {
            const queue = new InMemoryQueueBox();
            const { reserved, current } = entries();
            await queue.enqueue(current);

            const release = queue.releaseEntries([reserved], {
                status: EntityStatus.COMPLETED,
                delayMs: null
            });

            if (accepted) {
                expect(firstValue(await release)).toEqual(current);
            }
            else {
                await expect(release).rejects.toMatchObject({
                    code: 'resource-inbox-lost-reservation'
                });
            }
        }
    );
    it('returns the existing entry from enqueueIfAbsent without overwriting it', async () => {
        const queue = new InMemoryQueueBox();
        const original = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 1 })
        });
        const replacement = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 2 })
        });

        expect(await queue.enqueueIfAbsent(original)).toBe(original);
        expect(await queue.enqueueIfAbsent(replacement)).toBe(original);

        const reserved = await queue.reserveEntries(
            new Set([original.typeId]),
            new Set([EntityStatus.NEW]),
            1
        );

        expect(firstValue(reserved).resource).toBe(original.resource);
    });

    it('uses enqueueIf predicate to decide whether active entries are overwritten', async () => {
        const queue = new InMemoryQueueBox();
        const original = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 1 })
        });
        const skippedReplacement = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 2 })
        });
        const acceptedReplacement = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 3 })
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
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 })
        });
        const replacement = createEntry('presence.state.v1', 'resource-1', {
            resource: JSON.stringify({ version: 2 })
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
                status: EntityStatus.COMPLETED
            })
        );
        await queue.enqueue(createEntry('chat.message.v1', 'active-1'));

        expect(queue.cleanup()).toBe(true);

        const completed = await queue.reserveEntries(
            new Set(['chat.message.v1']),
            new Set([EntityStatus.COMPLETED]),
            10
        );
        const active = await queue.reserveEntries(
            new Set(['chat.message.v1']),
            new Set([EntityStatus.NEW]),
            10
        );

        expect(completed.size).toBe(0);
        expect(active.size).toBe(1);
    });

    it('treats expired entries as absent work and removes them during cleanup', async () => {
        const queue = new InMemoryQueueBox();
        const expiresAt = Temporal.Now.instant().subtract({ seconds: 1 });

        await queue.enqueue(
            createEntry('chat.message.v1', 'expired-1', {
                expiryTs: expiresAt
            })
        );
        await queue.enqueue(createEntry('chat.message.v1', 'active-1'));

        expect(
            await queue.getItem({
                topicId: 'chat.message.v1',
                resourceId: 'expired-1',
                contextId: 'ctx-1'
            })
        ).toBeUndefined();
        expect(await queue.deleteExpired()).toBe(0);

        const active = await queue.reserveEntries(
            new Set(['chat.message.v1']),
            new Set([EntityStatus.NEW]),
            10
        );

        expect(active.size).toBe(1);
    });

    it('applies the exact millisecond delay when retry entries are released', async () => {
        const queue = new InMemoryQueueBox();
        const entry = createEntry('chat.private-text.v1', 'retry-1', {
            status: EntityStatus.RESERVED,
            attempts: 1
        });
        await queue.enqueue(entry);

        const released = firstValue(
            await queue.releaseEntries([entry], { status: EntityStatus.RETRY, delayMs: 37 })
        );

        expect(released.status).toBe(EntityStatus.RETRY);
        expect(released.dequeueAudit.endTs).toBeDefined();
        expect(released.dequeueAudit.nextTs).toBeDefined();

        const delayMs = released.dequeueAudit
            .endTs!.until(released.dequeueAudit.nextTs!)
            .total({ unit: 'milliseconds' });
        expect(delayMs).toBe(37);
        expect((await queue.getItem(entry.key))?.dequeueAudit.endTs?.toString())
            .toBe(released.dequeueAudit.endTs?.toString());
        expect((await queue.getItem(entry.key))?.dequeueAudit.nextTs?.toString())
            .toBe(released.dequeueAudit.nextTs?.toString());
    });

    it('rejects a stale release without overwriting a newer reservation', async () => {
        const queue = new InMemoryQueueBox();
        const current = createEntry('chat.private-text.v1', 'stale-release', {
            status: EntityStatus.RESERVED,
            attempts: 2
        });
        const stale = {
            ...current,
            dequeueAudit: {
                ...current.dequeueAudit,
                attempts: 1
            }
        };
        await queue.enqueue(current);

        await expect(queue.releaseEntries([stale], { status: EntityStatus.RETRY, delayMs: 1 }))
            .rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });

        expect(await queue.getItem(current.key)).toMatchObject({
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 2 }
        });
    });

    it('treats the exact already-completed AppInbox reservation as an idempotent success release', async () => {
        const queue = new InMemoryQueueBox();
        const reserved = createEntry(EnqueuedType.APP_INBOX, 'atomic-success', {
            status: EntityStatus.RESERVED,
            attempts: 7
        });
        await queue.enqueue({ ...reserved, status: EntityStatus.COMPLETED });

        const released = await queue.releaseEntries(
            [reserved],
            { status: EntityStatus.COMPLETED, delayMs: null }
        );

        expect(firstValue(released)).toMatchObject({
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 7 }
        });
        await expect(queue.releaseEntries(
            [{ ...reserved, dequeueAudit: { ...reserved.dequeueAudit, attempts: 6 } }],
            { status: EntityStatus.COMPLETED, delayMs: null }
        )).rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        await expect(queue.releaseEntries(
            [reserved],
            { status: EntityStatus.FAILED, delayMs: null }
        )).rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
    });

    it('reclaims only live stale exhausted AppInbox reservations for finalization', async () => {
        const queue = new InMemoryQueueBox();
        const staleStart = Temporal.Now.instant().subtract({ minutes: 6 });
        const exhausted = createEntry(EnqueuedType.APP_INBOX, 'recover-exhaustion', {
            status: EntityStatus.RESERVED,
            attempts: 20,
            startTs: staleStart
        });
        await queue.enqueue(exhausted);
        await queue.enqueue(createEntry(EnqueuedType.APP_OUTBOX, 'wrong-type', {
            status: EntityStatus.RESERVED,
            attempts: 20,
            startTs: staleStart
        }));
        await queue.enqueue(createEntry(EnqueuedType.APP_INBOX, 'expired', {
            status: EntityStatus.RESERVED,
            attempts: 20,
            startTs: staleStart,
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 })
        }));

        const recovered = await queue.reserveRetryExhaustionFinalizations(
            new Set([EnqueuedType.APP_INBOX, EnqueuedType.APP_OUTBOX]),
            {
                processingAttempts: 20,
                maxToReserve: 10,
                staleAfterMs: 5 * 60 * 1000
            }
        );

        expect([...recovered.values()]).toEqual([
            expect.objectContaining({
                entry: expect.objectContaining({
                    key: exhausted.key,
                    status: EntityStatus.RESERVED,
                    dequeueAudit: expect.objectContaining({ attempts: 21 })
                }),
                selectedDueTs: staleStart
            })
        ]);
        expect(
            (await queue.reserveRetryExhaustionFinalizations(
                new Set([EnqueuedType.APP_INBOX]),
                {
                    processingAttempts: 20,
                    maxToReserve: 10,
                    staleAfterMs: 5 * 60 * 1000
                }
            )).size
        ).toBe(0);
    });

    it('skips poison finalization generations without consuming a valid bounded batch', async () => {
        const queue = new InMemoryQueueBox();
        const poison = createEntry(EnqueuedType.APP_INBOX, '000-overflow', {
            status: EntityStatus.RESERVED,
            attempts: Number.MAX_SAFE_INTEGER,
            startTs: Temporal.Now.instant().subtract({ minutes: 6 })
        });
        const valid = createEntry(EnqueuedType.APP_INBOX, 'zzz-valid', {
            status: EntityStatus.RESERVED,
            attempts: 20,
            startTs: Temporal.Now.instant().subtract({ minutes: 6 })
        });
        await queue.enqueue(poison);
        await queue.enqueue(valid);

        const selected = await queue.reserveRetryExhaustionFinalizations(
            new Set([EnqueuedType.APP_INBOX]),
            {
                processingAttempts: 20,
                maxToReserve: 1,
                staleAfterMs: 5 * 60 * 1000
            }
        );

        expect(firstValue(selected).entry).toMatchObject({
            key: valid.key,
            dequeueAudit: { attempts: 21 }
        });
        expect((await queue.getItem(poison.key))?.dequeueAudit.attempts)
            .toBe(Number.MAX_SAFE_INTEGER);
    });

    it('does not advertise finalization work when only poison generations remain', async () => {
        const queue = new InMemoryQueueBox();
        await queue.enqueue(createEntry(EnqueuedType.APP_INBOX, 'overflow-only', {
            status: EntityStatus.RESERVED,
            attempts: Number.MAX_SAFE_INTEGER,
            startTs: Temporal.Now.instant().subtract({ minutes: 6 })
        }));

        await expect(queue.isAnyEntryToLock(
            new Set([EnqueuedType.APP_INBOX]),
            {
                checkTimeout: RateLimiter.init(60_000, 1),
                checkFairness: RateLimiter.init(60_000, 1),
                checkFinalization: RateLimiter.init(60_000, 1),
                maxAttempts: 20,
                finalizationStaleAfterMs: 5 * 60 * 1000
            }
        )).resolves.toBe(false);
    });

    it('rolls back the whole memory release batch when one reservation is stale', async () => {
        const queue = new InMemoryQueueBox();
        const first = createEntry('chat.private-text.v1', 'batch-current', {
            status: EntityStatus.RESERVED,
            attempts: 1
        });
        const second = createEntry('chat.private-text.v1', 'batch-stale', {
            status: EntityStatus.RESERVED,
            attempts: 2
        });
        await queue.enqueue(first);
        await queue.enqueue(second);

        await expect(queue.releaseEntries([
            first,
            {
                ...second,
                dequeueAudit: { ...second.dequeueAudit, attempts: 1 }
            }
        ], { status: EntityStatus.COMPLETED, delayMs: null })).rejects.toMatchObject({
            code: 'resource-inbox-lost-reservation'
        });

        expect((await queue.getItem(first.key))?.status).toBe(EntityStatus.RESERVED);
        expect((await queue.getItem(second.key))?.dequeueAudit.attempts).toBe(2);
    });

    it.each(
        [
            ['retry without delay', { status: EntityStatus.RETRY, delayMs: null }],
            ['retry with zero delay', { status: EntityStatus.RETRY, delayMs: 0 }],
            ['retry with fractional delay', { status: EntityStatus.RETRY, delayMs: 1.5 }],
            ['terminal with delay', { status: EntityStatus.COMPLETED, delayMs: 1 }],
            ['unsupported status', { status: EntityStatus.RESERVED, delayMs: null }]
        ] as const
    )('atomically rejects invalid memory release disposition: %s', async (
        _scenario,
        disposition
    ) => {
        const queue = new InMemoryQueueBox();
        const first = createEntry('chat.private-text.v1', `invalid-first-${_scenario}`, {
            status: EntityStatus.RESERVED,
            attempts: 1
        });
        const second = createEntry('chat.private-text.v1', `invalid-second-${_scenario}`, {
            status: EntityStatus.RESERVED,
            attempts: 1
        });
        await queue.enqueue(first);
        await queue.enqueue(second);

        await expect(queue.releaseEntries([first, second], disposition as never))
            .rejects.toMatchObject({ code: 'resource-inbox-invalid-release-disposition' });

        expect((await queue.getItem(first.key))?.status).toBe(EntityStatus.RESERVED);
        expect((await queue.getItem(second.key))?.status).toBe(EntityStatus.RESERVED);
    });

    it('uses a custom two-attempt reservation budget', async () => {
        const queue = new InMemoryQueueBox();
        const exhausted = createEntry('chat.private-text.v1', 'attempt-3', {
            status: EntityStatus.RETRY,
            attempts: 2,
            nextTs: Temporal.Now.instant().subtract({ seconds: 1 })
        });
        await queue.enqueue(exhausted);

        const reserved = await queue.reserveEntries(
            new Set([exhausted.typeId]),
            new Set([EntityStatus.RETRY]),
            { maxToReserve: 1, maxAttempts: 2 }
        );

        expect(reserved.size).toBe(0);
        expect((await queue.getItem(exhausted.key))?.dequeueAudit.attempts).toBe(2);
    });

    it.each(
        [
            ['ordinary retry', {
                status: EntityStatus.RETRY,
                nextTs: Temporal.Now.instant().subtract({ seconds: 1 })
            }],
            ['timed out reservation', {
                status: EntityStatus.RESERVED,
                startTs: Temporal.Now.instant().subtract({ minutes: 10 })
            }]
        ] as const
    )('does not advertise exhausted %s work', async (_lane, entryOptions) => {
        const queue = new InMemoryQueueBox();
        const exhausted = createEntry('chat.private-text.v1', `advertise-${_lane}`, {
            ...entryOptions,
            attempts: 2
        });
        await queue.enqueue(exhausted);

        const advertised = await queue.isAnyEntryToLock(
            new Set([exhausted.typeId]),
            {
                checkTimeout: RateLimiter.init(60_000, 1),
                checkFairness: RateLimiter.init(60_000, 1),
                checkFinalization: RateLimiter.init(60_000, 1),
                maxAttempts: 2,
                finalizationStaleAfterMs: 5 * 60 * 1000
            } as never
        );
        const reserved = entryOptions.status === EntityStatus.RETRY
            ? await queue.reserveEntries(
                new Set([exhausted.typeId]),
                new Set([EntityStatus.RETRY]),
                { maxToReserve: 1, maxAttempts: 2 }
            )
            : await queue.reserveTimeoutEntries(
                new Set([exhausted.typeId]),
                { maxToReserve: 1, maxAttempts: 2 },
                Temporal.Duration.from({ minutes: 5 })
            );

        expect(advertised).toBe(false);
        expect(reserved.size).toBe(0);
    });

    it('increments memory timeout recovery attempts and enforces its budget', async () => {
        const queue = new InMemoryQueueBox();
        const oldStartTs = Temporal.Now.instant().subtract({ minutes: 10 });
        const recoverable = createEntry('chat.private-text.v1', 'timeout-2', {
            status: EntityStatus.RESERVED,
            attempts: 1,
            startTs: oldStartTs
        });
        await queue.enqueue(recoverable);

        const reclaimed = await queue.reserveTimeoutEntries(
            new Set([recoverable.typeId]),
            { maxToReserve: 1, maxAttempts: 2 },
            Temporal.Duration.from({ minutes: 5 })
        );

        expect(firstValue(reclaimed).dequeueAudit.attempts).toBe(2);
        expect(firstValue(reclaimed).dequeueAudit.startTs?.toString())
            .not.toBe(oldStartTs.toString());
        expect(firstValue(reclaimed).dequeueAudit.endTs).toBeUndefined();

        expect(
            (await queue.reserveTimeoutEntries(
                new Set([recoverable.typeId]),
                { maxToReserve: 1, maxAttempts: 2 },
                Temporal.Duration.from({ milliseconds: 0 })
            )).size
        ).toBe(0);
    });

    it('returns fairness metadata separately from the canonical reserved entry', async () => {
        const queue = new InMemoryQueueBox();
        const selectedDueTs = Temporal.Now.instant().subtract({ seconds: 31 });
        const overdue = createEntry('chat.private-text.v1', 'fairness-contract', {
            status: EntityStatus.RETRY,
            attempts: 1,
            startTs: Temporal.Now.instant().subtract({ minutes: 1 }),
            endTs: Temporal.Now.instant().subtract({ seconds: 40 }),
            nextTs: selectedDueTs
        });
        await queue.enqueue(overdue);

        const selected = firstValue(
            await queue.reserveOverdueRetryEntries(
                new Set([overdue.typeId]),
                Date.now() - 30_000,
                1
            )
        );

        expect(selected.selectedDueTs.toString()).toBe(selectedDueTs.toString());
        expect(selected.entry.status).toBe(EntityStatus.RESERVED);
        expect(selected.entry.dequeueAudit.nextTs).toBeUndefined();
        expect((await queue.getItem(overdue.key))?.dequeueAudit.nextTs).toBeUndefined();
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
        startTs: Temporal.Instant;
        endTs: Temporal.Instant;
        nextTs: Temporal.Instant;
    }> = {}
): ResourceEntry {
    return {
        key: {
            topicId: typeId,
            resourceId,
            contextId: 'ctx-1'
        },
        resource: options.resource ?? JSON.stringify({ typeId, resourceId }),
        typeId,
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: options.expiryTs ?? NEVER_EXPIRE_TS
        },
        status: options.status ?? EntityStatus.NEW,
        dequeueAudit: {
            startTs: options.startTs,
            endTs: options.endTs,
            nextTs: options.nextTs,
            attempts: options.attempts ?? 0
        },
        db: undefined
    };
}

function firstValue<K, V>(map: Map<K, V>): V {
    const first = map.values().next().value;
    if (first === undefined) {
        throw new Error('Expected at least one map value');
    }
    return first;
}
