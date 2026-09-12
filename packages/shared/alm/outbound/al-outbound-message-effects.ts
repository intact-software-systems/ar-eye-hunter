import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isNotReadyException } from '../../queuebox/resource-inbox/not-ready-exception.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import { toError } from '../../resilience/to-error.ts';
import type { ALWorkAttemptResult } from '../work/al-work-handler.ts';
import type { ALWorkOutcome } from '../work/al-work-queue-port.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot
} from './admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundSettledSendResult,
    ALOutboundSettlementEmitter,
    ALOutboundSettlementFact
} from './al-outbound-message-runtime.ts';
import type { ALOutboundPendingAdmission } from './al-outbound-pending-admission.ts';
import type { ALOutboundComputedDto } from './compute-al-outbound-dispatch.ts';
import { isALOutboundReceiptComplete } from './transition-al-outbound-pending-ack.ts';

export namespace ALOutboundMessageEffects {
    export interface Dependencies<TPrepared> {
        readonly runtime: ALOutboundMessageRuntime.Dependencies<TPrepared>;
        readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
        readonly commitDispatchPlan: (
            dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
        ) => Promise<ALOutboundComputedDto<TPrepared>>;
        /** Aborts with the runtime, so an aborted signal is exactly a disposed runtime. */
        readonly sendSignal: AbortSignal;
        readonly settlements: ALOutboundSettlementEmitter;
    }

    /** One claimed attempt on one prepared copy, with the identity its settlements carry. */
    export interface PreparedSend<TPrepared> {
        readonly attemptId: string;
        readonly payload: Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'send-prepared'; }>;
        readonly lifecycle: ALOutboundMessageRuntime.SendLifecycle;
        readonly attempts: number;
    }
}

/** Runs the message-shaped durable effects: pending admission, dequeued admission, and prepared sends. */
export class ALOutboundMessageEffects<TPrepared> {
    private readonly dependencies: ALOutboundMessageEffects.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundMessageEffects.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
    }

    async admitPendingMessage(effect: ALOutboundEffectSnapshot<TPrepared>): Promise<ALWorkOutcome> {
        const pending = effect.payload;
        const msg = effect.canonicalMessage;
        if (pending.kind !== 'admit-message' || !msg) {
            throw new NonRetryableException('Pending work has no canonical admission');
        }
        const runtime = this.dependencies.runtime;
        const authority = await runtime.readPendingAdmissionAuthority?.(msg, pending.preparedMessages) ??
            { status: 'authorized' };
        const skip = computeALOutboundRetainedAdmissionSkip({
            msgId: pending.message.msgId,
            expiresAtMs: pending.message.expiresAtMs,
            nowMs: this.readNowMs(),
            disposed: this.dependencies.sendSignal.aborted,
            authority
        });
        if (skip) {
            if (skip.settlement) {
                this.dependencies.settlements(skip.settlement);
            }
            return skip.outcome;
        }
        const result = await this.dependencies.dispatchAdmission.commit({
            msg,
            planner: () => toALOutboundRetainedDispatchPlan(msg, pending),
            intent: 'enqueue',
            phase: 'immediate',
            origin: 'drain',
            options: { pendingAdmission: effect.entry }
        });
        this.dependencies.settlements({
            kind: 'admission',
            msgId: pending.message.msgId,
            verdict: result.computed.verdict
        });
        return { status: 'completed' };
    }

    /**
     * The breaker's whole accounting for the dequeue path: the work handler turns a rejection and a
     * thrown store error alike into an outcome, so an attempt that never returns still owes a charge.
     */
    async admitDequeuedMessage(effect: ALOutboundEffectSnapshot<TPrepared>): Promise<ALWorkOutcome> {
        const { resilience } = this.dependencies.runtime.dequeue;
        if (resilience.isNotAllowedThroughToDequeue()) {
            return { status: 'not-ready', readyAtMs: this.readNowMs() + resilience.toCircuitOpenBackoffMs() };
        }
        try {
            const outcome = await this.readDequeuedAdmissionOutcome(effect);
            outcome.status === 'retry' ? resilience.failure() : resilience.success();
            return outcome;
        }
        catch (error) {
            if (!(error instanceof Error && isNotReadyException(error))) {
                resilience.failure();
            }
            throw error;
        }
    }

    private async readDequeuedAdmissionOutcome(
        effect: ALOutboundEffectSnapshot<TPrepared>
    ): Promise<ALWorkOutcome> {
        const runtime = this.dependencies.runtime;
        const msg = effect.canonicalMessage;
        if (!msg) {
            throw new NonRetryableException('Dequeued work has no message');
        }
        if (await runtime.admissionStore.isMessageSuperseded(msg)) {
            return { status: 'completed' };
        }
        const computed = await this.dependencies.commitDispatchPlan({
            msg,
            planner: runtime.planDequeuedMessage,
            intent: 'dequeue',
            phase: 'dequeue',
            origin: 'drain',
            options: {
                observedOutboxEntry: effect.entry,
                attemptIdentity: JSON.stringify([
                    'queue',
                    effect.attempts,
                    effect.entry.dequeueAudit.startTs?.toString() ?? null
                ])
            }
        });
        if (computed.status === 'expired' || computed.status === 'superseded' || computed.status === 'skipped') {
            return { status: 'completed' };
        }
        if (computed.status === 'no-route') {
            return { status: 'retry' };
        }
        await runtime.afterDequeueAdmission?.(msg, effect.entry);
        return { status: 'completed' };
    }

    /**
     * A throwing carrier, admission read or receipt read still ends the attempt this owner already
     * stated: without this the work handler reschedules and the retry restates `attempt-started`
     * under the same id, leaving the first attempt open forever.
     */
    async writePreparedMessage(send: ALOutboundMessageEffects.PreparedSend<TPrepared>): Promise<ALWorkAttemptResult> {
        try {
            return await this.writeAttemptedSend(send);
        }
        catch (error) {
            this.dependencies.settlements({
                kind: 'attempt-settled',
                msgId: send.payload.message.msgId,
                attemptId: send.attemptId,
                outcome: 'failed',
                submissionAttempted: false,
                detail: toError(error).message,
                willRetry: true
            });
            throw error;
        }
    }

    private async writeAttemptedSend(
        send: ALOutboundMessageEffects.PreparedSend<TPrepared>
    ): Promise<ALWorkAttemptResult> {
        const runtime = this.dependencies.runtime;
        const { lifecycle } = send;
        const msgId = send.payload.message.msgId;
        if (await runtime.admissionStore.isMessageSuperseded(lifecycle.canonicalMessage)) {
            this.dependencies.settlements({
                kind: 'attempt-settled',
                msgId,
                attemptId: send.attemptId,
                outcome: 'superseded',
                submissionAttempted: false,
                detail: 'A newer message superseded this attempt before its carrier ran.',
                willRetry: false
            });
            return { status: 'completed' };
        }
        // A complete receipt already stated the delivery; this attempt owes no settlement of its own.
        const receipts = await runtime.admissionStore.readReceiptState(msgId);
        if (receipts && isALOutboundReceiptComplete(receipts)) {
            return { status: 'completed' };
        }
        if (lifecycle.expiresAtMs !== undefined && lifecycle.expiresAtMs <= this.readNowMs()) {
            this.dependencies.settlements({
                kind: 'expired',
                msgId,
                detail: 'The message deadline passed before its carrier ran.'
            });
            return { status: 'completed' };
        }
        if (lifecycle.signal.aborted) {
            return { status: 'completed' };
        }
        const retry = retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, send.attempts, runtime.random());
        const sendResult = await runtime.sendPreparedMessage(send.payload.prepared, send.payload.phase, lifecycle);
        const timing = {
            observedAtMs: this.readNowMs(),
            retryDelayMs: retry.delayMs ?? 0,
            expiresAtMs: lifecycle.expiresAtMs
        };
        if (sendResult.status === 'queued') {
            return {
                status: 'retained',
                settled: sendResult.settled.then((settled) =>
                    this.writeSettledSend(send, settled, { ...timing, observedAtMs: this.readNowMs() })
                )
            };
        }
        return this.writeSettledSend(send, sendResult, timing);
    }

    /** The carrier settled one attempt: its outcome is stated, then the deadline that may end the message. */
    private writeSettledSend(
        send: ALOutboundMessageEffects.PreparedSend<TPrepared>,
        settled: ALOutboundSettledSendResult,
        timing: ALOutboundSettlementTiming
    ): ALWorkOutcome {
        const disposition = computeALOutboundSendDisposition(settled, timing);
        const msgId = send.payload.message.msgId;
        // A `not-ready` attempt the deadline ended carries no meaning of its own: the expiry is the fact.
        if (disposition.expiredDetail === undefined || settled.status !== 'not-ready') {
            this.dependencies.settlements({
                kind: 'attempt-settled',
                msgId,
                attemptId: send.attemptId,
                outcome: settled.status,
                submissionAttempted: settled.submissionAttempted,
                detail: settled.reason,
                willRetry: disposition.outcome.status === 'retry' || disposition.outcome.status === 'not-ready'
            });
        }
        if (disposition.expiredDetail !== undefined) {
            this.dependencies.settlements({ kind: 'expired', msgId, detail: disposition.expiredDetail });
        }
        return disposition.outcome;
    }

    private readNowMs(): number {
        return this.dependencies.runtime.clock.nowMs();
    }
}

interface ALOutboundSettlementTiming {
    readonly observedAtMs: number;
    readonly retryDelayMs: number;
    readonly expiresAtMs: number | undefined;
}

/** What one settled attempt means for its work row, and whether the deadline ended the message. */
interface ALOutboundSendDisposition {
    readonly outcome: ALWorkOutcome;
    /** Set when the deadline, not the carrier, decided this attempt is the message's last. */
    readonly expiredDetail: string | undefined;
}

/** Why a retained admission never reaches its commit, and the fact it states on the way out. */
interface ALOutboundRetainedAdmissionSkip {
    readonly outcome: ALWorkOutcome;
    /** Absent for disposal alone: a runtime that is going away states nothing about the message. */
    readonly settlement: ALOutboundSettlementFact | undefined;
}

interface ComputeALOutboundRetainedAdmissionSkipInput {
    readonly msgId: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
    readonly disposed: boolean;
    readonly authority: ALOutboundMessageRuntime.PendingAdmissionAuthority;
}

function computeALOutboundSendDisposition(
    result: ALOutboundSettledSendResult,
    timing: ALOutboundSettlementTiming
): ALOutboundSendDisposition {
    if (timing.expiresAtMs !== undefined && timing.observedAtMs >= timing.expiresAtMs) {
        return {
            outcome: { status: 'completed' },
            expiredDetail: 'The message deadline passed before its attempt settled.'
        };
    }
    if (result.status !== 'not-ready' && result.status !== 'failed') {
        return { outcome: { status: 'completed' }, expiredDetail: undefined };
    }
    if (result.status === 'failed') {
        return { outcome: { status: 'retry' }, expiredDetail: undefined };
    }
    const retryAtMs = timing.observedAtMs + Math.max(1, result.retryAfterMs ?? timing.retryDelayMs);
    return {
        outcome: {
            status: 'not-ready',
            readyAtMs: timing.expiresAtMs === undefined ? retryAtMs : Math.min(retryAtMs, timing.expiresAtMs)
        },
        expiredDetail: undefined
    };
}

function computeALOutboundRetainedAdmissionSkip(
    input: ComputeALOutboundRetainedAdmissionSkipInput
): ALOutboundRetainedAdmissionSkip | undefined {
    const { authority } = input;
    if (input.disposed || input.expiresAtMs <= input.nowMs || authority.status === 'rejected') {
        return {
            outcome: { status: 'completed' },
            settlement: toALOutboundRetainedAdmissionSkipSettlement(input)
        };
    }
    if (authority.status === 'not-ready') {
        return {
            outcome: { status: 'not-ready', readyAtMs: input.nowMs + authority.retryAfterMs },
            settlement: {
                kind: 'admission',
                msgId: input.msgId,
                verdict: { kind: 'deferred', reason: 'not-yet-in-sync', detail: authority.reason }
            }
        };
    }
    return undefined;
}

function toALOutboundRetainedAdmissionSkipSettlement(
    input: ComputeALOutboundRetainedAdmissionSkipInput
): ALOutboundSettlementFact | undefined {
    if (input.expiresAtMs <= input.nowMs) {
        return {
            kind: 'expired',
            msgId: input.msgId,
            detail: 'The retained admission reached its deadline before it was replayed.'
        };
    }
    return input.authority.status === 'rejected'
        ? {
            kind: 'admission',
            msgId: input.msgId,
            verdict: { kind: 'refused', reason: 'unauthorized', detail: input.authority.reason }
        }
        : undefined;
}

function toALOutboundRetainedDispatchPlan<TPrepared>(
    msg: ALMessage,
    pending: ALOutboundPendingAdmission<TPrepared>
): ALOutboundDispatchPlan<TPrepared> {
    return {
        msg,
        dropReasonCode: undefined,
        persist: pending.policy.persist,
        preparedMessages: pending.preparedMessages,
        ackTracking: pending.policy.ackTracking ?? undefined,
        retryTracking: pending.policy.retryTracking ?? undefined,
        repairTracking: pending.policy.repairTracking ?? undefined,
        supersedenceTracking: pending.policy.supersedenceTracking ?? undefined
    };
}
