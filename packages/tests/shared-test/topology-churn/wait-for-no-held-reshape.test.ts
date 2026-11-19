import { waitForNoHeldReshape } from '@shared-test/black-box-runner/topology-churn/wait-for-no-held-reshape.ts';
import type { HeldTopologyReshape } from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { describe, expect, it } from 'vitest';

const START = 1_000_000;

/** Serves the readings in order, the last one for ever; the clock moves only when the wait sleeps. */
async function runWait(readings: readonly (HeldTopologyReshape | null)[]) {
    let now = START;
    const readsAt: number[] = [];
    const outcome = await waitForNoHeldReshape({
        readHeldReshape: () => {
            readsAt.push(now);
            return Promise.resolve(readings[Math.min(readsAt.length, readings.length) - 1] ?? null);
        },
        nowEpochMs: () => now,
        sleepUntil: (epochMs) => {
            now = Math.max(now, epochMs);
            return Promise.resolve();
        },
        boundMs: 75_000,
        sampleIntervalMs: 250
    });
    return { outcome, readsAt };
}

function heldUntil(opensAtEpochMs: number): HeldTopologyReshape {
    return { wantedReasons: ['kind-change'], opensAtEpochMs };
}

describe('waitForNoHeldReshape', () => {
    it('returns at once for a room that owes no reshape', async () => {
        expect(await runWait([null])).toEqual({ outcome: null, readsAt: [START] });
    });

    it('sleeps until the gate opens instead of sampling the hold', async () => {
        expect(await runWait([heldUntil(START + 20_000), null]))
            .toEqual({ outcome: null, readsAt: [START, START + 20_000] });
    });

    it('samples at the interval while an open gate still owes its reshape', async () => {
        const open = heldUntil(START - 10_000);

        expect(await runWait([open, open, null])).toEqual({ outcome: null, readsAt: [START, START + 250, START + 500] });
    });

    it('returns the reshape still held when the bound runs out, after a last read at the bound', async () => {
        const held = heldUntil(START + 20_000);
        const { outcome, readsAt } = await runWait([held]);

        expect(outcome).toEqual(held);
        expect(readsAt.at(0)).toBe(START);
        expect(readsAt.at(1)).toBe(START + 20_000);
        expect(readsAt.at(-1)).toBe(START + 75_000);
    });

    it('reads once more at the bound when the gate opens after it', async () => {
        const late = heldUntil(START + 200_000);

        expect(await runWait([late])).toEqual({ outcome: late, readsAt: [START, START + 75_000] });
    });
});
