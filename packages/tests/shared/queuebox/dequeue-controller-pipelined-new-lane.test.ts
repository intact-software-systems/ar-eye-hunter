import { describe, expect, it, vi } from 'vitest';

import { DequeueController, Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';

interface PipelinedLaneInput {
    readonly maxConcurrentComputes: number;
    readonly maxToReserve: number;
    readonly maxNumToDequeue: number;
    /** The rows each reservation call returns, in call order; a call past the script returns none. */
    readonly reservations: readonly (readonly string[])[];
    readonly exclusionKeys?: Readonly<Record<string, string>>;
    readonly failRelease?: (key: string) => Error | undefined;
}

interface PipelinedLane {
    readonly controller: DequeueController<string, string, string>;
    /** The row count each reservation call asked for. */
    readonly asked: number[];
    /** Compute and release events in the order they happened. */
    readonly events: string[];
    /** The keys of each success release call. */
    readonly releaseCalls: string[][];
    /** Records the start of a row, then holds its compute until the test finishes that row. */
    readonly compute: (key: string) => Promise<string>;
    readonly finish: (key: string) => void;
}

interface ComputeGates {
    readonly events: string[];
    readonly finishes: Map<string, () => void>;
}

describe('DequeueController pipelined lane', () => {
    it('reserves again as each compute settles instead of waiting for the slowest of a reservation', async () => {
        const lane = createPipelinedLane({
            maxConcurrentComputes: 2,
            maxToReserve: 2,
            maxNumToDequeue: 4,
            reservations: [['long', 'short-1'], ['short-2'], ['short-3']]
        });
        const dequeued = lane.controller.dequeueForCompute(lane.compute);

        await vi.waitFor(() => expect(lane.events).toContain('start:short-1'));
        lane.finish('short-1');
        await vi.waitFor(() => expect(lane.events).toContain('start:short-2'));
        lane.finish('short-2');
        await vi.waitFor(() => expect(lane.events).toContain('start:short-3'));
        lane.finish('short-3');
        await vi.waitFor(() => expect(lane.events).toContain('release:short-3'));

        expect(lane.asked).toEqual([2, 1, 1]);
        expect(lane.events).not.toContain('end:long');
        expect(lane.releaseCalls).toEqual([['short-1'], ['short-2'], ['short-3']]);

        lane.finish('long');
        const results = await dequeued;

        expect([...results.get(Reservator.NEW)!.keys()].sort()).toEqual(['long', 'short-1', 'short-2', 'short-3']);
        expect(lane.releaseCalls.at(-1)).toEqual(['long']);
        expect(lane.asked).toEqual([2, 1, 1]);
    });

    it('orders overlapping exclusion keys across reservations and holds no keyless row behind them', async () => {
        const lane = createPipelinedLane({
            maxConcurrentComputes: 3,
            maxToReserve: 3,
            maxNumToDequeue: 6,
            reservations: [['group-1', 'free-1', 'free-2'], ['group-2'], ['free-3']],
            exclusionKeys: { 'group-1': 'app:group', 'group-2': 'app:group:caller' }
        });
        const dequeued = lane.controller.dequeueForCompute(lane.compute);

        await vi.waitFor(() => expect(lane.events).toContain('start:free-2'));
        lane.finish('free-1');
        await vi.waitFor(() => expect(lane.asked).toEqual([3, 1]));
        lane.finish('free-2');
        await vi.waitFor(() => expect(lane.events).toContain('start:free-3'));

        expect(lane.events).not.toContain('start:group-2');

        lane.finish('group-1');
        await vi.waitFor(() => expect(lane.events).toContain('start:group-2'));
        lane.finish('group-2');
        lane.finish('free-3');
        await dequeued;

        expect(lane.events.indexOf('end:group-1')).toBeLessThan(lane.events.indexOf('start:group-2'));
        expect(lane.asked).toEqual([3, 1, 1, 1]);
    });

    it('stops reserving after a reservation that claimed fewer than asked and still finishes the rows in flight', async () => {
        const lane = createPipelinedLane({
            maxConcurrentComputes: 3,
            maxToReserve: 3,
            maxNumToDequeue: 8,
            reservations: [['a', 'b', 'c']]
        });
        const dequeued = lane.controller.dequeueForCompute(lane.compute);

        await vi.waitFor(() => expect(lane.events).toContain('start:c'));
        lane.finish('b');
        await vi.waitFor(() => expect(lane.asked).toEqual([3, 1]));
        lane.finish('a');
        lane.finish('c');
        const results = await dequeued;

        expect([...results.get(Reservator.NEW)!.keys()].sort()).toEqual(['a', 'b', 'c']);
        expect(lane.releaseCalls.flat().sort()).toEqual(['a', 'b', 'c']);
        expect(lane.asked).toEqual([3, 1]);
    });

    it('stops reserving after a release error, still releases the rows in flight and rethrows the first error', async () => {
        const failure = new Error('release lost its reservation');
        const lane = createPipelinedLane({
            maxConcurrentComputes: 2,
            maxToReserve: 2,
            maxNumToDequeue: 8,
            reservations: [['a', 'b'], ['c', 'd']],
            failRelease: (key) => key === 'b' ? failure : undefined
        });
        const dequeued = lane.controller.dequeueForCompute(lane.compute);

        await vi.waitFor(() => expect(lane.events).toContain('start:b'));
        lane.finish('b');
        await vi.waitFor(() => expect(lane.events).toContain('release:b'));
        lane.finish('a');

        await expect(dequeued).rejects.toBe(failure);
        expect(lane.releaseCalls).toEqual([['b'], ['a']]);
        expect(lane.asked).toEqual([2]);
    });

    it('computes the rows of one reservation in order, one at a time, on a serial lane', async () => {
        const lane = createPipelinedLane({
            maxConcurrentComputes: 1,
            maxToReserve: 3,
            maxNumToDequeue: 3,
            reservations: [['a', 'b', 'c']]
        });
        const dequeued = lane.controller.dequeueForCompute(lane.compute);

        for (const key of ['a', 'b', 'c']) {
            await vi.waitFor(() => expect(lane.events).toContain(`start:${key}`));
            lane.finish(key);
        }
        await dequeued;

        expect(lane.events.filter((event) => !event.startsWith('release:'))).toEqual([
            'start:a',
            'end:a',
            'start:b',
            'end:b',
            'start:c',
            'end:c'
        ]);
        expect(lane.releaseCalls).toEqual([['a'], ['b'], ['c']]);
        expect(lane.asked).toEqual([3]);
    });
});

function createPipelinedLane(input: PipelinedLaneInput): PipelinedLane {
    const asked: number[] = [];
    const events: string[] = [];
    const releaseCalls: string[][] = [];
    const finishes = new Map<string, () => void>();
    const budget = {
        maxToReserve: input.maxToReserve,
        maxNumToDequeue: input.maxNumToDequeue,
        maxConcurrentComputes: input.maxConcurrentComputes
    };
    const controller = DequeueController.create<string, string, string>({ debug: () => {}, warn: () => {}, error: () => {} })
        .withInboxTypesToDequeue(() => new Set(['APP_INBOX']))
        .withReturnDequeuedEntries(true)
        .withWorkAdvertisement({ FINALIZATION: false, NEW: true, RETRY: false, FAIRNESS: false, TIMEOUT: false })
        .withLaneBudgets(() => ({ FINALIZATION: budget, NEW: budget, FAIRNESS: budget, RETRY: budget, TIMEOUT: budget }))
        .withComputeExclusion((key) => input.exclusionKeys?.[key])
        .onNewEntriesReserveDo(async (_types, numToReserve) => {
            const rows = input.reservations[asked.length] ?? [];
            asked.push(numToReserve);
            return new Map(rows.map((key) => [key, key]));
        })
        .onReleaseEntriesDo(async (successes) => {
            const keys = [...successes.keys()];
            releaseCalls.push(keys);
            events.push(...keys.map((key) => `release:${key}`));
            const failure = keys.map((key) => input.failRelease?.(key)).find((error) => error !== undefined);
            if (failure !== undefined) {
                throw failure;
            }
            return successes;
        }, async (failures) => failures);
    return {
        controller,
        asked,
        events,
        releaseCalls,
        compute: (key) => computeGated(key, { events, finishes }),
        finish: (key) => finishes.get(key)!()
    };
}

async function computeGated(key: string, gates: ComputeGates): Promise<string> {
    gates.events.push(`start:${key}`);
    const gate = Promise.withResolvers<void>();
    gates.finishes.set(key, gate.resolve);
    await gate.promise;
    gates.events.push(`end:${key}`);
    return key;
}
