export interface DurableSendRunInput {
    readonly runId: string;
    readonly warmupCount: number;
    readonly measuredCount: number;
    /** The main-thread load the sends run under, or none for an idle page. */
    readonly frameLoad: FrameLoadInput | undefined;
}

export interface FrameLoadInput {
    readonly busyMsPerFrame: number;
    readonly frameIntervalMs: number;
}

export interface FrameLoadObservation {
    readonly frameCount: number;
    /** The share of the run's wall time the load kept the main thread busy. */
    readonly busyShare: number;
}

export interface DurableSendRun {
    /** One entry per measured send: `enqueueIfAbsent` call to the carrier's `sendPreparedMessage`, in ms. */
    readonly sendToDispatchMs: readonly number[];
    /** Sends whose batch emitted no readiness probe within the settle bound, so the next send did not wait for it. */
    readonly unsettledCount: number;
    readonly frameLoad: FrameLoadObservation | undefined;
}

export interface DurableSendHarness {
    runSends(input: DurableSendRunInput): Promise<DurableSendRun>;
}

export const DURABLE_SEND_HARNESS_GLOBAL = 'almDurableSendHarness';
