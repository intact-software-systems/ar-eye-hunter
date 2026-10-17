import { describe, expect, it, vi } from 'vitest';

import {
    DequeueController,
    hasAdvertisedDequeueWork,
    Reservator
} from '@shared/queuebox/dequeue/dequeue-controller.ts';

const NOTHING_ADVERTISED: DequeueController.WorkAdvertisement = {
    FINALIZATION: false,
    NEW: false,
    RETRY: false,
    FAIRNESS: false,
    TIMEOUT: false
};

interface ControllerLanes {
    readonly controller: DequeueController<string, string, string>;
    readonly reservations: string[];
}

describe('DequeueController work advertisement', () => {
    it('offers a reservation only to the lanes the probe reported non-empty, in lane order', async () => {
        const lanes = createControllerLanes({ ...NOTHING_ADVERTISED, RETRY: true, FAIRNESS: true });

        const dequeued = await lanes.controller.dequeueForCompute(async () => 'done');

        expect(lanes.reservations).toEqual(['FAIRNESS', 'RETRY']);
        expect(dequeued.get(Reservator.FAIRNESS)?.has('FAIRNESS-work')).toBe(true);
        expect(dequeued.get(Reservator.RETRY)?.has('RETRY-work')).toBe(true);
        expect(dequeued.get(Reservator.NEW)?.size).toBe(0);
        expect(dequeued.get(Reservator.FINALIZATION)?.size).toBe(0);
    });

    it('offers every lane when no probe preceded the pass', async () => {
        const lanes = createControllerLanes(undefined);

        await lanes.controller.dequeueForCompute(async () => 'done');

        expect(lanes.reservations).toEqual(['FINALIZATION', 'NEW', 'FAIRNESS', 'RETRY', 'TIMEOUT']);
    });

    it('claims nothing and reserves nothing for an empty advertisement', async () => {
        const lanes = createControllerLanes(NOTHING_ADVERTISED);

        const dequeued = await lanes.controller.dequeueForCompute(async () => 'done');

        expect(lanes.reservations).toEqual([]);
        expect([...dequeued.values()].every((lane) => lane.size === 0)).toBe(true);
        expect(hasAdvertisedDequeueWork(NOTHING_ADVERTISED)).toBe(false);
        expect(hasAdvertisedDequeueWork({ ...NOTHING_ADVERTISED, TIMEOUT: true })).toBe(true);
    });

    it('still requires a positive budget for every lane, advertised or not', async () => {
        const lanes = createControllerLanes({ ...NOTHING_ADVERTISED, NEW: true });
        lanes.controller.withLaneBudgets(() => ({
            FINALIZATION: { maxToReserve: 1, maxNumToDequeue: 1 },
            NEW: { maxToReserve: 1, maxNumToDequeue: 1 },
            FAIRNESS: { maxToReserve: 1, maxNumToDequeue: 1 },
            RETRY: { maxToReserve: 1, maxNumToDequeue: 1 },
            TIMEOUT: { maxToReserve: 0, maxNumToDequeue: 1 }
        }));

        await expect(lanes.controller.dequeueForCompute(async () => 'done')).rejects.toBeInstanceOf(TypeError);
        expect(lanes.reservations).toEqual([]);
    });
});

function createControllerLanes(advertisement: DequeueController.WorkAdvertisement | undefined): ControllerLanes {
    const reservations: string[] = [];
    const reserve = (lane: Reservator) =>
        vi.fn(async () => {
            reservations.push(lane);
            return new Map([[`${lane}-work`, 'work']]);
        });
    const controller = DequeueController.create<string, string, string>({ debug: () => {}, warn: () => {}, error: () => {} })
        .withMaxNumToDequeue(1)
        .withMaxNumToReserve(() => 1)
        .withInboxTypesToDequeue(() => new Set(['APP_INBOX']))
        .withReturnDequeuedEntries(true)
        .withWorkAdvertisement(advertisement)
        .onNewEntriesReserveDo(reserve(Reservator.NEW))
        .onRetryEntriesReserveDo(reserve(Reservator.RETRY))
        .onFairnessEntriesReserveDo(reserve(Reservator.FAIRNESS))
        .onTimeoutEntriesReserveDo(reserve(Reservator.TIMEOUT))
        .onFinalizationEntriesReserveDo(reserve(Reservator.FINALIZATION))
        .onFinalizationEntriesDo(async (key) => key)
        .onReleaseEntriesDo(async (entries) => entries, async (entries) => entries);
    return { controller, reservations };
}
