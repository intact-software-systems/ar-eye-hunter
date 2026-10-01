import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALWorkReadinessProbeCause } from '@shared/alm/work/al-work-readiness-memory.ts';

import type {
    DurableSendBatchEnd,
    DurableSendReceiptEnd
} from './durable-send-harness-contract.ts';
import type { PacedFrameLoad } from './paced-frame-load.ts';

const SETTLE_BOUND_MS = 2_000;

export class DurableSendDispatchTimeoutError extends Error {
    constructor(sendIndex: number) {
        super(
            `Send ${sendIndex} did not reach its first dispatch within ${SETTLE_BOUND_MS} ms of its start`
        );
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
    /** Armed at the dispatch, so it ends on the drain of the batch that dispatched it, or the probe after it. */
    readonly batchDrain: Promise<DurableSendBatchDrain>;
}

interface BatchDrainWaiter {
    readonly observedProbeCauses: ALWorkReadinessProbeCause[];
    drained: boolean;
    readonly end: (endedOn: DurableSendBatchEnd) => void;
}

namespace DurableSendObservation {
    export interface Input {
        readonly frameLoad: PacedFrameLoad;
        /** Where a send's batch goes idle for this plan: its drain, or the readiness probe that follows the drain. */
        readonly batchEnd: Exclude<DurableSendBatchEnd, 'timeout'>;
    }
}

/**
 * The carrier's send calls, the durable lane's drains and readiness probes, and its settlements, as the page observes
 * them. A send's wait runs from its dispatch to its batch's drain, or the probe after it, so a probe that came back
 * after a minimal send's batch would pass here unseen: the probe-diagnostics and ledger unit tests pin that, not this
 * harness. A receipt's wait takes the first durable drain after the acknowledgement, not one keyed to the ACK's batch,
 * and relies on IndexedDB ordering that batch's trailing probe before the next send's dispatch.
 */
export class DurableSendObservation {
    private readonly frameLoad: PacedFrameLoad;
    private readonly batchEnd: Exclude<DurableSendBatchEnd, 'timeout'>;
    private readonly dispatchWaiters = new Map<string, (dispatch: DurableSendDispatch) => void>();
    private batchDrainWaiters: BatchDrainWaiter[] = [];
    private readonly acknowledgementWaiters = new Map<string, () => void>();
    private drainWaiters: (() => void)[] = [];

    constructor(input: DurableSendObservation.Input) {
        this.frameLoad = input.frameLoad;
        this.batchEnd = input.batchEnd;
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
            this.observeProbe(event.cause);
        }
        else if (event.kind === 'effect-drain' && event.lane === 'durable') {
            this.observeDrain();
        }
    }

    /** A complete acknowledgement settles the send's receipt; an incomplete one or none leaves it open. */
    observeSettlement(settlement: ALDeliverySettlement): void {
        if (settlement.kind === 'acknowledgement' && settlement.complete) {
            this.acknowledgementWaiters.get(settlement.msgId)?.();
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

    /** Armed before the receipt is handed over: the acknowledgement it settles and the batch its commit wakes. */
    async waitForReceiptEnd(msgId: string): Promise<DurableSendReceiptEnd> {
        const [acknowledged, drained] = await Promise.all([
            this.waitForAcknowledgement(msgId),
            this.waitForEffectDrain()
        ]);
        if (!acknowledged) {
            return 'unacknowledged';
        }
        return drained ? 'acknowledged' : 'undrained';
    }

    private observeProbe(cause: ALWorkReadinessProbeCause): void {
        for (const waiter of [...this.batchDrainWaiters]) {
            waiter.observedProbeCauses.push(cause);
            if (waiter.drained) {
                waiter.end('readiness-probe');
            }
        }
    }

    private observeDrain(): void {
        for (const waiter of [...this.batchDrainWaiters]) {
            if (this.batchEnd === 'effect-drain') {
                waiter.end('effect-drain');
            }
            else {
                waiter.drained = true;
            }
        }
        for (const end of [...this.drainWaiters]) {
            end();
        }
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
            this.batchDrainWaiters.push({ observedProbeCauses, drained: false, end });
        });
    }

    private waitForAcknowledgement(msgId: string): Promise<boolean> {
        return new Promise((resolve) => {
            const end = (acknowledged: boolean) => {
                clearTimeout(timer);
                this.acknowledgementWaiters.delete(msgId);
                resolve(acknowledged);
            };
            const timer = setTimeout(() => end(false), SETTLE_BOUND_MS);
            this.acknowledgementWaiters.set(msgId, () => end(true));
        });
    }

    private waitForEffectDrain(): Promise<boolean> {
        return new Promise((resolve) => {
            const end = (drained: boolean) => {
                clearTimeout(timer);
                this.drainWaiters = this.drainWaiters.filter((waiter) => waiter !== onDrain);
                resolve(drained);
            };
            const onDrain = () => end(true);
            const timer = setTimeout(() => end(false), SETTLE_BOUND_MS);
            this.drainWaiters.push(onDrain);
        });
    }
}
