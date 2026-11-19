import type { HeldTopologyReshape } from '@shared/api/topology-plan/topology-reshape-gate.ts';

export interface WaitForNoHeldReshapeInput {
    /** The room's `heldReshape`, read from the formation view under a present member's session. */
    readonly readHeldReshape: () => Promise<HeldTopologyReshape | null>;
    readonly nowEpochMs: () => number;
    readonly sleepUntil: (epochMs: number) => Promise<void>;
    readonly boundMs: number;
    readonly sampleIntervalMs: number;
}

/**
 * Null once the room owes no reshape; the reshape still held when the bound ran out. A closed gate is slept out
 * rather than sampled; an open gate that still owes its reshape is sampled until the work plans the room.
 */
export async function waitForNoHeldReshape(input: WaitForNoHeldReshapeInput): Promise<HeldTopologyReshape | null> {
    const deadlineEpochMs = input.nowEpochMs() + input.boundMs;
    for (;;) {
        const heldReshape = await input.readHeldReshape();
        const nowEpochMs = input.nowEpochMs();
        if (heldReshape === null || nowEpochMs >= deadlineEpochMs) {
            return heldReshape;
        }
        await input.sleepUntil(
            Math.min(deadlineEpochMs, Math.max(nowEpochMs + input.sampleIntervalMs, heldReshape.opensAtEpochMs))
        );
    }
}
