import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALWorkReadinessProbeCause } from '@shared/alm/work/al-work-handler.ts';

import type { DurableSendBatchEnd } from './durable-send-harness-contract.ts';
import type { PacedFrameLoad } from './paced-frame-load.ts';

const SETTLE_BOUND_MS = 2_000;

export class DurableSendDispatchTimeoutError extends Error {
    constructor(sendIndex: number) {
        super(`Send ${sendIndex} did not reach its first dispatch within ${SETTLE_BOUND_MS} ms of its start`);
        this.name = 'DurableSendDispatchTimeoutError';
    }
}

export interface DurableSendBatchDrain {
    readonly endedOn: DurableSendBatchEnd;
    readonly observedProbeCauses: readonly ALWorkReadinessProbeCause[];
}

export interface DurableSendDispatch {
    readonly atMs: number;
    readonly framesStarted: number;
    /** Armed at the dispatch, so it ends on the drain of the batch that dispatched it. */
    readonly batchDrain: Promise<DurableSendBatchDrain>;
}

interface BatchDrainWaiter {
    readonly observedProbeCauses: ALWorkReadinessProbeCause[];
    readonly end: (endedOn: DurableSendBatchEnd) => void;
}

/** The carrier's send calls and the durable lane's drains and readiness probes, as the page observes them. */
export class DurableSendObservation {
    private readonly frameLoad: PacedFrameLoad;
    private readonly dispatchWaiters = new Map<string, (dispatch: DurableSendDispatch) => void>();
    private batchDrainWaiters: BatchDrainWaiter[] = [];

    constructor(frameLoad: PacedFrameLoad) {
        this.frameLoad = frameLoad;
    }

    observeDispatch(msgId: string): void {
        const atMs = performance.now();
        const resolveDispatch = this.dispatchWaiters.get(msgId);
        if (resolveDispatch === undefined) {
            return;
        }
        this.dispatchWaiters.delete(msgId);
        resolveDispatch({
            atMs,
            framesStarted: this.frameLoad.getFramesStarted(),
            batchDrain: this.startBatchDrainWait()
        });
    }

    observeDiagnostics(event: ALOutboundRuntimeDiagnosticsEvent): void {
        if (event.kind === 'readiness-probe' && event.lane === 'durable') {
            for (const waiter of this.batchDrainWaiters) {
                waiter.observedProbeCauses.push(event.cause);
            }
        }
        else if (event.kind === 'effect-drain' && event.lane === 'durable') {
            for (const waiter of [...this.batchDrainWaiters]) {
                waiter.end('effect-drain');
            }
        }
    }

    waitForDispatch(msgId: string, sendIndex: number): Promise<DurableSendDispatch> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.dispatchWaiters.delete(msgId);
                reject(new DurableSendDispatchTimeoutError(sendIndex));
            }, SETTLE_BOUND_MS);
            this.dispatchWaiters.set(msgId, (dispatch) => {
                clearTimeout(timer);
                resolve(dispatch);
            });
        });
    }

    private startBatchDrainWait(): Promise<DurableSendBatchDrain> {
        return new Promise((resolve) => {
            const observedProbeCauses: ALWorkReadinessProbeCause[] = [];
            const end = (endedOn: DurableSendBatchEnd) => {
                clearTimeout(timer);
                this.batchDrainWaiters = this.batchDrainWaiters.filter((waiter) => waiter.end !== end);
                resolve({ endedOn, observedProbeCauses });
            };
            const timer = setTimeout(() => end('timeout'), SETTLE_BOUND_MS);
            this.batchDrainWaiters.push({ observedProbeCauses, end });
        });
    }
}
