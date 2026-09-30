import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALWorkAttemptResult } from '../../work/al-work-handler.ts';
import type { ALWorkOutcome } from '../../work/al-work-queue-port.ts';
import type { ALOutboundEffectSnapshot } from '../admission/al-outbound-admission-store.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundSettlementEmitter
} from '../al-outbound-message-runtime.ts';

export const AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS = 50;

type ALOutboundAuthorityReader<TPrepared> = NonNullable<
    ALOutboundMessageRuntime.Dependencies<TPrepared>['readPendingAdmissionAuthority']
>;

export interface ReadALOutboundDequeueWaitInput<TPrepared> {
    readonly effect: ALOutboundEffectSnapshot<TPrepared>;
    /** The carrier's authority read; a carrier without one never waits here. */
    readonly readAuthority: ALOutboundMessageRuntime.Dependencies<TPrepared>['readPendingAdmissionAuthority'];
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
 * once per claim, never once per re-check.
 */
export async function readALOutboundDequeueWait<TPrepared>(
    input: ReadALOutboundDequeueWaitInput<TPrepared>
): Promise<ALWorkAttemptResult | undefined> {
    const msg = input.effect.canonicalMessage;
    const readAuthority = input.readAuthority;
    const authority = msg === undefined || readAuthority === undefined
        ? undefined
        : await readAuthority(msg, []);
    if (msg === undefined || readAuthority === undefined || authority?.status !== 'not-ready') {
        return undefined;
    }
    input.settlements({
        kind: 'attempt-settled',
        msgId: msg.id.msgId,
        attemptId: input.effect.effectId,
        outcome: 'not-ready',
        submissionAttempted: false,
        detail: authority.reason,
        willRetry: true
    });
    return {
        status: 'retained',
        settled: holdALOutboundDequeueClaim({ input, msg, readAuthority })
    };
}

async function holdALOutboundDequeueClaim<TPrepared>(
    hold: ALOutboundDequeueHold<TPrepared>
): Promise<ALWorkOutcome> {
    const { clock, signal, effect } = hold.input;
    const endAtMs = Math.min(effect.leaseUntilMs ?? clock.nowMs(), effect.expireAtTimestamp);
    while (!signal.aborted && clock.nowMs() + AL_OUTBOUND_DEQUEUE_WAIT_RECHECK_MS < endAtMs) {
        await waitForALOutboundRecheck(signal);
        if ((await hold.readAuthority(hold.msg, [])).status !== 'not-ready') {
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
