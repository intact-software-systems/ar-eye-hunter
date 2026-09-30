import type { ALWorkReadinessProbeCause } from '@shared/alm/work/al-work-handler.ts';

export interface DurableSendRunInput {
    readonly runId: string;
    readonly warmupCount: number;
    readonly measuredCount: number;
    readonly frameLoad: FrameLoadInput | undefined;
}

export interface FrameLoadInput {
    readonly busyMsPerFrame: number;
    readonly frameIntervalMs: number;
}

export interface FrameLoadObservation {
    readonly frameCount: number;
    readonly busyShare: number;
    /** Per frame after the first: how late its animation callback ran against the frame clock. */
    readonly frameLatenessMs: readonly number[];
}

/**
 * The causes a send's own progress gives the durable probe that follows its batch: its commit emptied
 * the owner's readiness memory (and keeps the credit over the batch that ran behind it).
 * Probes from an external wake, the age bound, a retained release or a first read are not its own.
 */
export const DURABLE_SEND_OWN_PROBE_CAUSES: readonly ALWorkReadinessProbeCause[] = [
    'own-commit',
    'batch'
];

export type DurableSendProbeEnd = ALWorkReadinessProbeCause | 'timeout';

export interface DurableSendSample {
    /** `enqueueIfAbsent` call to the carrier's `sendPreparedMessage`. */
    readonly sendToDispatchMs: number;
    /** Where in the frame the send started; undefined on an idle page. */
    readonly phaseOffsetMs: number | undefined;
    /** Frame starts between the send's start and its dispatch. */
    readonly framesStraddled: number;
    /** The durable probe that ended the wait for the send's batch to go idle, or the bound. */
    readonly probeEnd: DurableSendProbeEnd;
    /** Every durable probe seen from the dispatch to the end of that wait. */
    readonly observedProbeCauses: readonly ALWorkReadinessProbeCause[];
}

export interface DurableSendRun {
    readonly samples: readonly DurableSendSample[];
    readonly frameLoad: FrameLoadObservation | undefined;
}

export interface DurableSendHarness {
    runSends(input: DurableSendRunInput): Promise<DurableSendRun>;
}

export const DURABLE_SEND_HARNESS_GLOBAL = 'almDurableSendHarness';
