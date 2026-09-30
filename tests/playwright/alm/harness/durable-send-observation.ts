import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALWorkReadinessProbeCause } from '@shared/alm/work/al-work-handler.ts';

import {
    DURABLE_SEND_OWN_PROBE_CAUSES,
    type DurableSendProbeEnd
} from './durable-send-harness-contract.ts';
import type { PacedFrameLoad } from './paced-frame-load.ts';

const SETTLE_BOUND_MS = 2_000;

export class DurableSendDispatchTimeoutError extends Error {
    constructor(sendIndex: number) {
        super(`Send ${sendIndex} was not dispatched within ${SETTLE_BOUND_MS} ms of its admission`);
        this.name = 'DurableSendDispatchTimeoutError';
    }
}

export interface DurableSendOwnProbe {
    readonly endedOn: DurableSendProbeEnd;
    readonly observedCauses: readonly ALWorkReadinessProbeCause[];
}

export interface DurableSendDispatch {
    readonly atMs: number;
    readonly framesStarted: number;
    /** Armed at the dispatch, so it ends only on a send-owned probe that came after it. */
    readonly ownProbe: Promise<DurableSendOwnProbe>;
}

interface OwnProbeWaiter {
    readonly observedCauses: ALWorkReadinessProbeCause[];
    readonly end: (endedOn: DurableSendProbeEnd) => void;
}

/** The carrier's send calls and the durable lane's readiness probes, as the page observes them. */
export class DurableSendObservation {
    private readonly frameLoad: PacedFrameLoad;
    private readonly dispatchWaiters = new Map<string, (dispatch: DurableSendDispatch) => void>();
    private ownProbeWaiters: OwnProbeWaiter[] = [];

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
            framesStarted: this.frameLoad.countFramesStarted(),
            ownProbe: this.armOwnProbe()
        });
    }

    observeDiagnostics(event: ALOutboundRuntimeDiagnosticsEvent): void {
        if (event.kind !== 'readiness-probe' || event.lane !== 'durable') {
            return;
        }
        for (const waiter of [...this.ownProbeWaiters]) {
            waiter.observedCauses.push(event.cause);
            if (DURABLE_SEND_OWN_PROBE_CAUSES.includes(event.cause)) {
                waiter.end(event.cause);
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

    private armOwnProbe(): Promise<DurableSendOwnProbe> {
        return new Promise((resolve) => {
            const observedCauses: ALWorkReadinessProbeCause[] = [];
            const end = (endedOn: DurableSendProbeEnd) => {
                clearTimeout(timer);
                this.ownProbeWaiters = this.ownProbeWaiters.filter((waiter) => waiter.end !== end);
                resolve({ endedOn, observedCauses });
            };
            const timer = setTimeout(() => end('timeout'), SETTLE_BOUND_MS);
            this.ownProbeWaiters.push({ observedCauses, end });
        });
    }
}
