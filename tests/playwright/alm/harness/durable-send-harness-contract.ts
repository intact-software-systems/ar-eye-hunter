import type { ALWorkReadinessProbeCause } from '@shared/alm/work/al-work-readiness-memory.ts';

/**
 * What a page sends: the ledger's minimal durable plan, or a receipted command, a durable WS unicast to the
 * server on the `command` channel, planned as the WS client plans it and acknowledged as the server does.
 */
export type DurableSendPlan = 'minimal' | 'receipted-command';

export const DURABLE_SEND_PLANS: readonly DurableSendPlan[] = ['minimal', 'receipted-command'];

/** The page URL's query parameter that names its plan, so each page composes one runtime for one plan. */
export const DURABLE_SEND_PLAN_PARAMETER = 'plan';

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
 * How a send's wait for its own batch ended: on that batch's durable `effect-drain`, on the readiness probe that
 * follows the drain, or at the bound. A receipted send ends on the probe: its commit also wrote the ACK-timeout row
 * due later, so the owner reads storage again after the batch instead of restoring its answer.
 */
export type DurableSendBatchEnd = 'effect-drain' | 'readiness-probe' | 'timeout';

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
    /** How the server's receipt, handed over once the batch went idle, ended. */
    readonly receiptEnd: DurableSendReceiptEnd;
}

/**
 * How the server's receipt for a send ended. `none`: the plan tracks no receipt. `acknowledged`: the receipt
 * settled complete and the batch its commit woke drained, so the next send starts on an idle owner with no
 * receipt open. `unacknowledged`: the receipt did not settle complete within the bound. `undrained`: it settled
 * complete, but no batch drained within the bound after it.
 */
export type DurableSendReceiptEnd = 'none' | 'acknowledged' | 'unacknowledged' | 'undrained';

export interface DurableSendRun {
    readonly samples: readonly DurableSendSample[];
    readonly frameLoad: FrameLoadObservation | undefined;
}

export interface DurableSendHarness {
    runSends(input: DurableSendRunInput): Promise<DurableSendRun>;
}

export const DURABLE_SEND_HARNESS_GLOBAL = 'almDurableSendHarness';
