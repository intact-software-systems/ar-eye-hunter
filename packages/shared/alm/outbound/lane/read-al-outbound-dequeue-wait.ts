import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALWorkAttemptResult } from '../../work/al-work-handler.ts';
import type { ALWorkOutcome } from '../../work/al-work-queue-port.ts';
import type { ALOutboundEffectSnapshot } from '../admission/al-outbound-admission-store.ts';
import type { ALOrderingBatchSequences } from '../admission/compute-al-ordering-prior-seq-record.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundSettlementEmitter
} from '../al-outbound-message-runtime.ts';

export const AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS = 50;

type ALOutboundAuthorityReader<TPrepared> = NonNullable<
    ALOutboundMessageRuntime.Dependencies<TPrepared>['readDequeuedAdmissionAuthority']
>;

/** Where a dequeued row's front leaves it: held, with the attempt its claim states, or passed on to its read. */
export type ALOutboundDequeueFront =
    | Readonly<{ kind: 'held'; attempt: ALWorkAttemptResult; }>
    | Readonly<{ kind: 'passed'; followsBatchPredecessor: boolean; }>;

export interface ReadALOutboundDequeueWaitInput<TPrepared> {
    readonly effect: ALOutboundEffectSnapshot<TPrepared>;
    /** The sequences the row's batch claimed beside it. */
    readonly batch: ALOrderingBatchSequences;
    /** The carrier's authority read; a carrier without one never waits here. */
    readonly readAuthority: ALOutboundMessageRuntime.Dependencies<TPrepared>['readDequeuedAdmissionAuthority'];
    readonly settlements: ALOutboundSettlementEmitter;
    readonly clock: ALOutboundMessageRuntime.Clock;
    readonly signal: AbortSignal;
}

interface ALOutboundDequeueHold<TPrepared> {
    readonly input: ReadALOutboundDequeueWaitInput<TPrepared>;
    readonly msg: ALMessage;
    readonly readAuthority: ALOutboundAuthorityReader<TPrepared>;
}

/**
 * A held message whose carrier authority is not ready: the claim states one retrying `not-ready` attempt, under the
 * row's own identity, and stays reserved while it re-reads the authority in memory. It releases once -- ready at once
 * when the authority returns or the owner goes away, at the lease or deadline otherwise -- so a gap writes to storage
 * once per claim, never once per re-check. Any other answer passes the row on to its read.
 */
export async function readALOutboundDequeueWait<TPrepared>(
    input: ReadALOutboundDequeueWaitInput<TPrepared>
): Promise<ALOutboundDequeueFront> {
    const msg = input.effect.canonicalMessage;
    const readAuthority = input.readAuthority;
    const authority = msg === undefined || readAuthority === undefined
        ? undefined
        : await readAuthority(msg, input.batch);
    if (msg === undefined || readAuthority === undefined || authority?.status !== 'not-ready') {
        return { kind: 'passed', followsBatchPredecessor: authority?.status === 'follows-batch-predecessor' };
    }
    input.settlements({
        kind: 'attempt-settled',
        msgId: msg.id.msgId,
        traceId: msg.id.traceId,
        attemptId: input.effect.effectId,
        outcome: 'not-ready',
        submissionAttempted: false,
        detail: authority.reason,
        willRetry: true
    });
    return {
        kind: 'held',
        attempt: { status: 'retained', settled: holdALOutboundDequeueClaim({ input, msg, readAuthority }) }
    };
}

async function holdALOutboundDequeueClaim<TPrepared>(
    hold: ALOutboundDequeueHold<TPrepared>
): Promise<ALWorkOutcome> {
    const { clock, signal, effect } = hold.input;
    const endAtMs = Math.min(effect.leaseUntilMs ?? clock.nowMs(), effect.expireAtTimestamp);
    while (!signal.aborted && clock.nowMs() + AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS < endAtMs) {
        await waitForALOutboundRecheck(signal);
        if ((await hold.readAuthority(hold.msg, hold.input.batch)).status !== 'not-ready') {
            return { status: 'not-ready', readyAtMs: clock.nowMs() };
        }
    }
    return {
        status: 'not-ready',
        readyAtMs: signal.aborted ? clock.nowMs() : Math.max(clock.nowMs(), endAtMs)
    };
}

function waitForALOutboundRecheck(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(done, AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS);
        signal.addEventListener('abort', done, { once: true });
        function done(): void {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
    });
}
