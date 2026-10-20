import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type {
    ResourceInboxReservationObservationRequest,
    ResourceInboxReservationObservationResult,
    ResourceInboxReservationRequest
} from '@shared/queuebox/queue-box-types.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

const TYPE = 'app-inbox.standing-flight.v1';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

interface GatedHandlers {
    /** The row ids whose handler started, in start order. */
    readonly started: string[];
    /** The most rows of one context that ran at once. */
    maxInFlightPerContext: number;
    finish(rowId: string, error?: Error): void;
}

interface StandingFlightReader {
    readonly reader: InboxQueueReader;
    readonly queue: ClaimRecordingQueueBox;
    readonly handlers: GatedHandlers;
    /** One settlement per row the flight took, in claim order. */
    readonly settlements: Promise<void>[];
    pass(resilience?: ResourceInboxResilience): Promise<number>;
}

/** Records the contexts each context-head claim excluded, per claimed status. */
class ClaimRecordingQueueBox extends InMemoryQueueBox {
    readonly excludedByClaim: { status: string; excluded: string[]; }[] = [];
    /** Runs before the next context-head claim reaches the store, once. */
    beforeNextClaim: (() => Promise<void>) | undefined;
    /** The row whose next release rejects, as a release that lost its reservation does. */
    failReleaseOf: string | undefined;

    override async releaseEntries(
        ...input: Parameters<InMemoryQueueBox['releaseEntries']>
    ): ReturnType<InMemoryQueueBox['releaseEntries']> {
        const [releases] = input;
        if (releases.some((release) => release.entry.key.resourceId === this.failReleaseOf)) {
            this.failReleaseOf = undefined;
            throw new Error('release lost its reservation');
        }
        return await super.releaseEntries(...input);
    }

    override reserveEntries(request: ResourceInboxReservationObservationRequest): Promise<ResourceInboxReservationObservationResult>;
    override reserveEntries(request: ResourceInboxReservationRequest): Promise<Map<Key, ResourceEntry>>;
    override async reserveEntries(
        request: ResourceInboxReservationRequest | ResourceInboxReservationObservationRequest
    ): Promise<Map<Key, ResourceEntry> | ResourceInboxReservationObservationResult> {
        const beforeNextClaim = this.beforeNextClaim;
        this.beforeNextClaim = undefined;
        await beforeNextClaim?.();
        if (request.contextClaim !== undefined) {
            this.excludedByClaim.push({ status: [...request.statusIds].join(','), excluded: [...request.contextClaim.excludedContextIds].sort() });
        }
        return 'reservationObservation' in request ? await super.reserveEntries(request) : await super.reserveEntries(request);
    }
}

describe('the AppInbox NEW lane with a standing flight', () => {
    it('returns from a pass while its rows run and holds at most the held-row bound across passes', async () => {
        const flight = createStandingFlightReader({ newLaneConcurrency: 2, newLaneHeldRows: 4 });
        await enqueue(flight.reader, contexts(6));

        expect(await flight.pass()).toBe(4);
        await vi.waitFor(() => expect(flight.handlers.started).toEqual(['row-0', 'row-1']));
        expect(flight.reader.isAwaitingFlightSettlement()).toBe(true);
        expect(await flight.pass()).toBe(0);

        flight.handlers.finish('row-0');
        await flight.settlements[0];
        expect(flight.reader.isAwaitingFlightSettlement()).toBe(false);
        expect(await flight.pass()).toBe(1);
        await vi.waitFor(() => expect(flight.handlers.started).toEqual(['row-0', 'row-1', 'row-2']));

        for (const rowId of ['row-1', 'row-2', 'row-3', 'row-4']) {
            await vi.waitFor(() => expect(flight.handlers.started).toContain(rowId));
            flight.handlers.finish(rowId);
        }
        await Promise.all(flight.settlements);
        expect(await flight.pass()).toBe(1);
        flight.handlers.finish('row-5');
        await Promise.all(flight.settlements);
        expect(await readStatuses(flight.queue)).toEqual(Array(6).fill(EntityStatus.COMPLETED));
        expect(flight.handlers.maxInFlightPerContext).toBe(1);
    });

    it('claims a context\'s next row once its head is released, not when the pass that claimed the head ends', async () => {
        const flight = createStandingFlightReader({ newLaneConcurrency: 4, newLaneHeldRows: 8 });
        await enqueue(flight.reader, ['shared', 'shared', 'other-1', 'other-2']);

        expect(await flight.pass()).toBe(3);
        await vi.waitFor(() => expect(flight.handlers.started).toEqual(['row-0', 'row-2', 'row-3']));
        // The shared context's next row stays unclaimed while its head is in flight.
        expect(await flight.pass()).toBe(0);
        expect(flight.queue.excludedByClaim.at(-1)).toEqual({ status: EntityStatus.NEW, excluded: ['other-1', 'other-2', 'shared'] });

        flight.handlers.finish('row-0');
        await flight.settlements[0];
        expect(await flight.pass()).toBe(1);
        expect(flight.queue.excludedByClaim.at(-1)).toEqual({ status: EntityStatus.NEW, excluded: ['other-1', 'other-2'] });
        await vi.waitFor(() => expect(flight.handlers.started).toEqual(['row-0', 'row-2', 'row-3', 'row-1']));
        expect(flight.handlers.started).not.toContain('row-4');

        for (const rowId of ['row-1', 'row-2', 'row-3']) {
            flight.handlers.finish(rowId);
        }
        await Promise.all(flight.settlements);
        expect(await readStatuses(flight.queue)).toEqual(Array(4).fill(EntityStatus.COMPLETED));
        expect(flight.handlers.maxInFlightPerContext).toBe(1);
    });

    it('claims due retries as context heads beside the flight, excluding every context with a row in flight', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const flight = createStandingFlightReader({ newLaneConcurrency: 2, newLaneHeldRows: 4, fakeClock: true });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await enqueue(flight.reader, ['retried', 'held']);

        expect(await flight.pass()).toBe(2);
        await vi.waitFor(() => expect(flight.handlers.started).toEqual(['row-0', 'row-1']));
        flight.handlers.finish('row-0', new Error('handler failed'));
        await flight.settlements[0];
        expect((await readStatuses(flight.queue))[0]).toBe(EntityStatus.RETRY);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(await flight.pass()).toBe(1);
        expect(flight.queue.excludedByClaim.filter(({ status }) => status === EntityStatus.RETRY).at(-1))
            .toEqual({ status: EntityStatus.RETRY, excluded: ['held'] });
        await vi.waitFor(() => expect(flight.handlers.started).toEqual(['row-0', 'row-1', 'row-0']));
        flight.handlers.finish('row-0');
        flight.handlers.finish('row-1');
        await Promise.all(flight.settlements);
        expect(await readStatuses(flight.queue)).toEqual([EntityStatus.COMPLETED, EntityStatus.COMPLETED]);
        expect(flight.handlers.maxInFlightPerContext).toBe(1);
    });

    it('counts each row that fails after its pass returned toward the breaker, which then stops the next top-up', async () => {
        const flight = createStandingFlightReader({ newLaneConcurrency: 2, newLaneHeldRows: 4 });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await enqueue(flight.reader, contexts(4));
        const resilience = createResilience(1);

        expect(await flight.pass(resilience)).toBe(4);
        await vi.waitFor(() => expect(flight.handlers.started).toHaveLength(2));
        flight.handlers.finish('row-0', new Error('storage unavailable'));
        flight.handlers.finish('row-1', new Error('storage unavailable'));
        await Promise.all(flight.settlements.slice(0, 2));

        expect(resilience.isNotAllowedThroughToDequeue()).toBe(true);
        expect(await flight.pass(resilience)).toBe(0);
        await vi.waitFor(() => expect(flight.handlers.started).toHaveLength(4));
        flight.handlers.finish('row-2');
        flight.handlers.finish('row-3');
        await Promise.all(flight.settlements);
    });

    it('tops up again at once after a pass that claimed nothing while a row settled during it', async () => {
        const flight = createStandingFlightReader({ newLaneConcurrency: 2, newLaneHeldRows: 4 });
        await enqueue(flight.reader, ['first', 'second']);
        expect(await flight.pass()).toBe(2);
        await vi.waitFor(() => expect(flight.handlers.started).toEqual(['row-0', 'row-1']));

        flight.queue.beforeNextClaim = async () => {
            flight.handlers.finish('row-0');
            await flight.settlements[0];
        };
        expect(await flight.pass()).toBe(0);

        expect(flight.reader.isAwaitingFlightSettlement()).toBe(false);
        expect(await flight.pass()).toBe(0);
        expect(flight.reader.isAwaitingFlightSettlement()).toBe(true);
        flight.handlers.finish('row-1');
        await Promise.all(flight.settlements);
    });

    it('keeps excluding a context whose row failed to release until that row\'s lease could have expired', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const flight = createStandingFlightReader({ newLaneConcurrency: 2, newLaneHeldRows: 4, fakeClock: true });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await enqueue(flight.reader, ['shared', 'shared']);
        expect(await flight.pass()).toBe(1);
        await vi.waitFor(() => expect(flight.handlers.started).toEqual(['row-0']));

        flight.queue.failReleaseOf = 'row-0';
        flight.handlers.finish('row-0');
        await expect(flight.settlements[0]).rejects.toThrow('release lost its reservation');
        await expect(flight.pass()).rejects.toThrow('release lost its reservation');

        // The failed row may still be RESERVED, so its context's next row must not run ahead of it.
        expect(await flight.pass()).toBe(0);
        expect(flight.queue.excludedByClaim.filter(({ status }) => status === EntityStatus.NEW).at(-1))
            .toEqual({ status: EntityStatus.NEW, excluded: ['shared'] });
        expect(flight.handlers.started).toEqual(['row-0']);
    });

    it('rejects a held-row bound below the lane\'s concurrency or above the largest flight', () => {
        const queue = new InMemoryQueueBox();
        const create = (newLaneHeldRows: number) =>
            new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 4, newLaneHeldRows });

        expect(() => create(3)).toThrow(RangeError);
        expect(() => create(InboxQueueReader.MAX_NEW_LANE_HELD_ROWS + 1)).toThrow(RangeError);
        expect(() => create(2.5)).toThrow(RangeError);
        expect(() => create(4)).not.toThrow();
        expect(() => create(InboxQueueReader.MAX_NEW_LANE_HELD_ROWS)).not.toThrow();
    });
});

function createStandingFlightReader(
    input: Readonly<{ newLaneConcurrency: number; newLaneHeldRows: number; fakeClock?: boolean; }>
): StandingFlightReader {
    const queue = input.fakeClock
        ? new ClaimRecordingQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
        : new ClaimRecordingQueueBox();
    const reader = new InboxQueueReader(queue, {
        laneBudgetPolicy: 'fixed-retry-two',
        newLaneConcurrency: input.newLaneConcurrency,
        newLaneHeldRows: input.newLaneHeldRows,
        nowEpochMs: () => Date.now()
    });
    const settlements: Promise<void>[] = [];
    reader.onFlightEntryDo((settlement) => {
        void settlement.catch(() => undefined);
        settlements.push(settlement);
    });
    const defaultResilience = createResilience();
    return {
        reader,
        queue,
        handlers: holdHandlers(reader),
        settlements,
        pass: (resilience = defaultResilience) => reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience)
    };
}

function holdHandlers(reader: InboxQueueReader): GatedHandlers {
    const gates = new Map<string, PromiseWithResolvers<void>>();
    const inFlightByContext = new Map<string, number>();
    const handlers: GatedHandlers = {
        started: [],
        maxInFlightPerContext: 0,
        finish: (rowId, error) => error === undefined ? gates.get(rowId)!.resolve() : gates.get(rowId)!.reject(error)
    };
    reader.onInboxMessageDo(TYPE, {
        onMessage: async (message, entry) => {
            const context = message.route.contextId;
            const gate = Promise.withResolvers<void>();
            gates.set(entry.key.resourceId, gate);
            handlers.started.push(entry.key.resourceId);
            inFlightByContext.set(context, (inFlightByContext.get(context) ?? 0) + 1);
            handlers.maxInFlightPerContext = Math.max(handlers.maxInFlightPerContext, inFlightByContext.get(context)!);
            try {
                await gate.promise;
            }
            finally {
                inFlightByContext.set(context, inFlightByContext.get(context)! - 1);
            }
        }
    });
    return handlers;
}

function contexts(count: number): string[] {
    return Array.from({ length: count }, (_value, index) => `context-${index}`);
}

async function enqueue(reader: InboxQueueReader, contextIds: readonly string[]): Promise<void> {
    for (const [index, contextId] of contextIds.entries()) {
        await reader.enqueueIfAbsent(newALUntargetedMessage(
            'api-v1',
            newALRoute('app-inbox.standing-flight', contextId, `row-${index}`),
            TYPE,
            { index },
            { ttlMs: 300_000 }
        ));
    }
}

async function readStatuses(queue: InMemoryQueueBox): Promise<string[]> {
    const entries = queue.peekKeys().map((key) => queue.peek(key)!);
    return entries.sort((left, right) => left.key.resourceId.localeCompare(right.key.resourceId)).map((entry) => entry.status);
}

function createResilience(failureThreshold = 10): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(failureThreshold, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1,
        retryPolicy: DEFAULT_RESOURCE_INBOX_RETRY_POLICY
    });
}
