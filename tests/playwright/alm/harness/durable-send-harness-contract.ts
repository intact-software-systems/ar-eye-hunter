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

/** How a send's wait for its own batch ended: on that batch's durable `effect-drain`, or at the bound. */
export type DurableSendBatchEnd = 'effect-drain' | 'timeout';

export interface DurableSendSample {
    /** `enqueueIfAbsent` call to the carrier's `sendPreparedMessage`. */
    readonly sendToDispatchMs: number;
    /** Where in the frame the send started; undefined on an idle page. */
    readonly phaseOffsetMs: number | undefined;
    /** Frame starts between the send's start and its dispatch. */
    readonly framesStraddled: number;
    /** What ended the wait for the send's batch to go idle. */
    readonly batchEnd: DurableSendBatchEnd;
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
