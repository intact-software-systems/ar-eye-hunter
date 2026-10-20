import { describe, expect, it, vi } from 'vitest';

import { DequeueController, Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { DequeueLaneFlight } from '@shared/queuebox/dequeue/dequeue-lane-flight.ts';

type ScriptedLane = typeof Reservator.NEW | typeof Reservator.RETRY | typeof Reservator.TIMEOUT;

interface StandingLaneInput {
    readonly maxConcurrentComputes: number;
    readonly maxUnreleased: number;
    readonly releasedKeyedRunsFirst?: boolean;
    /** The rows each reservation of a lane returns, or the error it rejects with, in call order; past the script, none. */
    readonly reservations: Readonly<Partial<Record<ScriptedLane, readonly (readonly string[] | Error)[]>>>;
    readonly exclusionKeys?: Readonly<Record<string, string>>;
    readonly failRelease?: (key: string) => Error | undefined;
    readonly releaseFailureClock?: () => number;
}

interface StandingLane {
    readonly flight: DequeueLaneFlight<string, string, string>;
    /** The row count each reservation call asked for, per lane, in call order. */
    readonly asked: string[];
    /** Compute and release events in the order they happened. */
    readonly events: string[];
    /** The settlement the flight handed out for each row it took. */
    readonly retained: Promise<void>[];
    /** Runs one pass of a fresh controller over the standing flight, as the queue reader does. */
    pass(lanes?: readonly ScriptedLane[]): Promise<number>;
    compute(key: string): Promise<string>;
    finish(key: string): void;
}

describe('DequeueController standing flight', () => {
    it('returns from a pass while its rows compute, and a later pass claims only the places that rows freed', async () => {
        const lane = createStandingLane({
            maxConcurrentComputes: 2,
            maxUnreleased: 4,
            reservations: { NEW: [['a', 'b'], ['c', 'd'], ['e']] }
        });

        expect(await lane.pass()).toBe(4);
        expect(lane.asked).toEqual(['NEW:2', 'NEW:2']);
        await vi.waitFor(() => expect(lane.events).toEqual(['start:a', 'start:b']));
        expect(lane.flight.getUnreleasedCount()).toBe(4);

        expect(await lane.pass()).toBe(0);
        expect(lane.asked).toEqual(['NEW:2', 'NEW:2']);

        lane.finish('a');
        await vi.waitFor(() => expect(lane.events).toContain('release:a'));
        await vi.waitFor(() => expect(lane.flight.getUnreleasedKeys()).toEqual(['b', 'c', 'd']));
        expect(await lane.pass()).toBe(1);
        expect(lane.asked).toEqual(['NEW:2', 'NEW:2', 'NEW:1']);

        for (const key of ['b', 'c', 'd', 'e']) {
            await vi.waitFor(() => expect(lane.events).toContain(`start:${key}`));
            lane.finish(key);
        }
        await Promise.all(lane.retained);
        expect(lane.flight.getUnreleasedCount()).toBe(0);
    });

    it('holds rows chained behind a keyed predecessor without their compute slots, so unchained rows keep running', async () => {
        const lane = createStandingLane({
            maxConcurrentComputes: 2,
            maxUnreleased: 4,
            reservations: { NEW: [['g1', 'g2'], ['g3', 'f1'], ['f2']] },
            exclusionKeys: { g1: 'app:group', g2: 'app:group', g3: 'app:group' }
        });

        expect(await lane.pass()).toBe(4);
        await vi.waitFor(() => expect(lane.events).toEqual(['start:g1', 'start:f1']));

        expect(await lane.pass()).toBe(0);
        lane.finish('f1');
        await vi.waitFor(() => expect(lane.flight.getUnreleasedCount()).toBe(3));
        expect(await lane.pass()).toBe(1);
        // The freed slot computes the next unchained row while the chain still waits for its head.
        await vi.waitFor(() => expect(lane.events).toContain('start:f2'));
        expect(lane.events).not.toContain('start:g2');

        lane.finish('g1');
        await vi.waitFor(() => expect(lane.events).toContain('start:g2'));
        lane.finish('g2');
        await vi.waitFor(() => expect(lane.events).toContain('start:g3'));
        lane.finish('g3');
        lane.finish('f2');
        await Promise.all(lane.retained);

        expect(lane.events.indexOf('end:g1')).toBeLessThan(lane.events.indexOf('start:g2'));
        expect(lane.events.indexOf('end:g2')).toBeLessThan(lane.events.indexOf('start:g3'));
        expect(lane.asked).toEqual(['NEW:2', 'NEW:2', 'NEW:1']);
    });

    it('gives a freed compute slot to a keyed row its chain head released ahead of earlier rows, and a fresh keyed row waits in turn', async () => {
        const lane = createStandingLane({
            maxConcurrentComputes: 1,
            maxUnreleased: 4,
            releasedKeyedRunsFirst: true,
            reservations: { NEW: [['keyed-1', 'free', 'other', 'keyed-2']] },
            exclusionKeys: { 'keyed-1': 'app:group-1', 'keyed-2': 'app:group-1', other: 'app:group-2' }
        });

        await lane.pass();
        for (const key of ['keyed-1', 'keyed-2', 'free', 'other']) {
            await vi.waitFor(() => expect(lane.events.filter((event) => event.startsWith('start:')).at(-1)).toBe(`start:${key}`));
            lane.finish(key);
        }
        await Promise.all(lane.retained);

        expect(lane.events.filter((event) => event.startsWith('start:')))
            .toEqual(['start:keyed-1', 'start:keyed-2', 'start:free', 'start:other']);
    });

    it('tops up the recovery lanes before NEW, and a retried keyed row computes after the chain row already in flight', async () => {
        const lane = createStandingLane({
            maxConcurrentComputes: 2,
            maxUnreleased: 3,
            reservations: { NEW: [['g1'], ['f1']], RETRY: [['retry-g']] },
            exclusionKeys: { g1: 'app:group', 'retry-g': 'app:group' }
        });

        expect(await lane.pass([Reservator.NEW])).toBe(1);
        await vi.waitFor(() => expect(lane.events).toEqual(['start:g1']));
        expect(await lane.pass([Reservator.NEW, Reservator.RETRY])).toBe(2);
        // The retry lane claims first; NEW then fills the one place left under the hold bound.
        expect(lane.asked).toEqual(['NEW:2', 'RETRY:2', 'NEW:1']);
        await vi.waitFor(() => expect(lane.events).toContain('start:f1'));
        expect(lane.events).not.toContain('start:retry-g');

        lane.finish('g1');
        await vi.waitFor(() => expect(lane.events).toContain('start:retry-g'));
        lane.finish('retry-g');
        lane.finish('f1');
        await Promise.all(lane.retained);

        expect(lane.events.indexOf('end:g1')).toBeLessThan(lane.events.indexOf('start:retry-g'));
    });

    it('adds a reclaimed timed-out row to the same flight, behind the keyed row of its key already in flight', async () => {
        const lane = createStandingLane({
            maxConcurrentComputes: 2,
            maxUnreleased: 2,
            reservations: { NEW: [['g1']], TIMEOUT: [['reclaimed-g'], ['late']] },
            exclusionKeys: { g1: 'app:group', 'reclaimed-g': 'app:group' }
        });

        expect(await lane.pass([Reservator.NEW])).toBe(1);
        expect(await lane.pass([Reservator.TIMEOUT])).toBe(1);
        // The flight now holds its bound across both lanes, so the next reclaim waits for a place.
        expect(await lane.pass([Reservator.TIMEOUT])).toBe(0);
        expect(lane.asked).toEqual(['NEW:2', 'TIMEOUT:1']);
        await vi.waitFor(() => expect(lane.events).toEqual(['start:g1']));

        lane.finish('g1');
        await vi.waitFor(() => expect(lane.events).toContain('start:reclaimed-g'));
        lane.finish('reclaimed-g');
        await Promise.all(lane.retained);
        expect(lane.events.indexOf('end:g1')).toBeLessThan(lane.events.indexOf('start:reclaimed-g'));
    });

    it('keeps releasing the other rows after one release fails, and the next pass rethrows that error once', async () => {
        const failure = new Error('release lost its reservation');
        const lane = createStandingLane({
            maxConcurrentComputes: 2,
            maxUnreleased: 2,
            reservations: { NEW: [['a', 'b'], ['c']] },
            failRelease: (key) => key === 'a' ? failure : undefined
        });

        expect(await lane.pass()).toBe(2);
        await vi.waitFor(() => expect(lane.events).toEqual(['start:a', 'start:b']));
        lane.finish('a');
        // The retained settlement resolves; only the next pass rethrows the release error, so it is reported once.
        await expect(lane.retained[0]).resolves.toBeUndefined();
        expect(lane.flight.isStopped()).toBe(true);
        lane.finish('b');
        await expect(lane.retained[1]).resolves.toBeUndefined();
        expect(lane.events).toContain('release:b');

        await expect(lane.pass()).rejects.toBe(failure);
        expect(lane.asked).toEqual(['NEW:2']);
        expect(await lane.pass()).toBe(1);
        expect(lane.asked).toEqual(['NEW:2', 'NEW:2']);
        lane.finish('c');
        await Promise.all(lane.retained.slice(2));
    });

    it('holds the key of a row whose release failed until the caller forgets failures older than its hold', async () => {
        const failure = new Error('release lost its reservation');
        let nowMs = 1_000;
        const lane = createStandingLane({
            maxConcurrentComputes: 1,
            maxUnreleased: 1,
            reservations: { NEW: [['a']] },
            failRelease: (key) => key === 'a' ? failure : undefined,
            releaseFailureClock: () => nowMs
        });

        await lane.pass();
        await vi.waitFor(() => expect(lane.events).toEqual(['start:a']));
        lane.finish('a');
        await expect(lane.retained[0]).resolves.toBeUndefined();

        expect(lane.flight.takeFirstError()).toBe(failure);
        expect(lane.flight.getUnreleasedKeys()).toEqual([]);
        expect(lane.flight.getReleaseFailedKeys()).toEqual(['a']);
        nowMs = 2_000;
        lane.flight.forgetReleaseFailuresBefore(1_000);
        expect(lane.flight.getReleaseFailedKeys()).toEqual(['a']);
        lane.flight.forgetReleaseFailuresBefore(1_001);
        expect(lane.flight.getReleaseFailedKeys()).toEqual([]);
    });

    it('rejects the pass whose reservation failed while the rows already in flight still compute and release', async () => {
        const failure = new Error('reservation unavailable');
        const lane = createStandingLane({
            maxConcurrentComputes: 2,
            maxUnreleased: 4,
            reservations: { NEW: [['a', 'b'], failure, ['c']] }
        });

        await expect(lane.pass()).rejects.toBe(failure);
        expect(lane.asked).toEqual(['NEW:2', 'NEW:2']);
        await vi.waitFor(() => expect(lane.events).toEqual(['start:a', 'start:b']));
        lane.finish('a');
        lane.finish('b');
        await Promise.all(lane.retained);
        expect(lane.events).toEqual(expect.arrayContaining(['release:a', 'release:b']));

        expect(await lane.pass()).toBe(1);
        expect(lane.asked).toEqual(['NEW:2', 'NEW:2', 'NEW:2']);
        lane.finish('c');
        await Promise.all(lane.retained);
    });

    it('claims nothing while the reservation admission refuses, and resumes topping up once it admits again', async () => {
        let admits = false;
        const lane = createStandingLane({
            maxConcurrentComputes: 1,
            maxUnreleased: 2,
            reservations: { NEW: [['a']] }
        }, () => admits);

        expect(await lane.pass()).toBe(0);
        expect(lane.asked).toEqual([]);
        admits = true;
        expect(await lane.pass()).toBe(1);
        lane.finish('a');
        await Promise.all(lane.retained);
    });

    it('keeps claim order on a serial per-pass lane: keyed rows do not go first there', async () => {
        const events: string[] = [];
        const finishes = new Map<string, () => void>();
        const budget = { maxToReserve: 3, maxNumToDequeue: 3, maxConcurrentComputes: 1 };
        const dequeued = DequeueController.create<string, string, string>(createSilentLog())
            .withInboxTypesToDequeue(() => new Set(['APP_INBOX']))
            .withWorkAdvertisement({ FINALIZATION: false, NEW: true, RETRY: false, FAIRNESS: false, TIMEOUT: false })
            .withLaneBudgets(() => ({ FINALIZATION: budget, NEW: budget, FAIRNESS: budget, RETRY: budget, TIMEOUT: budget }))
            .withComputeExclusion((key) => key.startsWith('keyed') ? `app:${key}` : undefined)
            .onNewEntriesReserveDo(async () => new Map([['keyed-1', 'keyed-1'], ['free', 'free'], ['keyed-2', 'keyed-2']]))
            .onReleaseEntriesDo(async (successes) => successes, async (failures) => failures)
            .dequeueForCompute((key) => computeGated(key, events, finishes));

        for (const key of ['keyed-1', 'free', 'keyed-2']) {
            await vi.waitFor(() => expect(events.at(-1)).toBe(`start:${key}`));
            finishes.get(key)!();
        }
        await dequeued;

        expect(events.filter((event) => event.startsWith('start:'))).toEqual(['start:keyed-1', 'start:free', 'start:keyed-2']);
    });
});

function createStandingLane(input: StandingLaneInput, admitsReservation: () => boolean = () => true): StandingLane {
    const asked: string[] = [];
    const events: string[] = [];
    const retained: Promise<void>[] = [];
    const finishes = new Map<string, () => void>();
    const flight = new DequeueLaneFlight<string, string, string>({
        maxConcurrentComputes: input.maxConcurrentComputes,
        maxUnreleased: input.maxUnreleased,
        releasedKeyedRunsFirst: input.releasedKeyedRunsFirst ?? true,
        toExclusionKey: (key) => input.exclusionKeys?.[key],
        releaseFailureClock: input.releaseFailureClock,
        retainSettlement: (settlement) => retained.push(settlement)
    });
    const budget = { maxToReserve: 2, maxNumToDequeue: 16, maxConcurrentComputes: input.maxConcurrentComputes };
    const reserve = (lane: ScriptedLane, numToReserve: number) => {
        const calls = asked.filter((call) => call.startsWith(`${lane}:`)).length;
        asked.push(`${lane}:${numToReserve}`);
        const rows = input.reservations[lane]?.[calls] ?? [];
        return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(new Map(rows.map((key) => [key, key])));
    };
    const compute = (key: string) => computeGated(key, events, finishes);
    const pass = async (lanes: readonly ScriptedLane[] = [Reservator.NEW]) => {
        let claimed = 0;
        await DequeueController.create<string, string, string>(createSilentLog())
            .withInboxTypesToDequeue(() => new Set(['APP_INBOX']))
            .withStandingFlight(flight)
            .withWorkAdvertisement({
                FINALIZATION: false,
                NEW: lanes.includes(Reservator.NEW),
                RETRY: lanes.includes(Reservator.RETRY),
                FAIRNESS: false,
                TIMEOUT: lanes.includes(Reservator.TIMEOUT)
            })
            .withLaneBudgets(() => ({ FINALIZATION: budget, NEW: budget, FAIRNESS: budget, RETRY: budget, TIMEOUT: budget }))
            .onReservationAdmissionDo(admitsReservation)
            .onNewEntriesReserveDo((_types, numToReserve) => reserve(Reservator.NEW, numToReserve))
            .onRetryEntriesReserveDo((_types, numToReserve) => reserve(Reservator.RETRY, numToReserve))
            .onTimeoutEntriesReserveDo((_types, numToReserve) => reserve(Reservator.TIMEOUT, numToReserve))
            .onClaimedEntries((entries) => {
                claimed += entries.size;
            })
            .onReleaseEntriesDo(async (successes) => {
                const keys = [...successes.keys()];
                events.push(...keys.map((key) => `release:${key}`));
                const failure = keys.map((key) => input.failRelease?.(key)).find((error) => error !== undefined);
                if (failure !== undefined) {
                    throw failure;
                }
                return successes;
            }, async (failures) => failures)
            .dequeueForCompute(compute);
        return claimed;
    };
    return { flight, asked, events, retained, pass, compute, finish: (key) => finishes.get(key)!() };
}

async function computeGated(key: string, events: string[], finishes: Map<string, () => void>): Promise<string> {
    events.push(`start:${key}`);
    const gate = Promise.withResolvers<void>();
    finishes.set(key, gate.resolve);
    await gate.promise;
    events.push(`end:${key}`);
    return key;
}

function createSilentLog(): Pick<Console, 'debug' | 'warn' | 'error'> {
    return { debug: () => {}, warn: () => {}, error: () => {} };
}
