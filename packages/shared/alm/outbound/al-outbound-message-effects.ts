import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isNotReadyException } from '../../queuebox/resource-inbox/not-ready-exception.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import type { ALWorkAttemptResult } from '../work/al-work-handler.ts';
import type { ALWorkOutcome } from '../work/al-work-queue-port.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot
} from './admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import type { ALOutboundMessageRuntime, ALOutboundSettledSendResult } from './al-outbound-message-runtime.ts';
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
        if (
            this.dependencies.sendSignal.aborted || pending.message.expiresAtMs <= this.readNowMs() ||
            authority.status === 'rejected'
        ) {
            return { status: 'completed' };
        }
        if (authority.status === 'not-ready') {
            return { status: 'not-ready', readyAtMs: this.readNowMs() + authority.retryAfterMs };
        }
        await this.dependencies.dispatchAdmission.commit({
            msg,
            planner: () => ({
                msg,
                dropReasonCode: undefined,
                persist: pending.policy.persist,
                preparedMessages: pending.preparedMessages,
                ackTracking: pending.policy.ackTracking ?? undefined,
                retryTracking: pending.policy.retryTracking ?? undefined,
                repairTracking: pending.policy.repairTracking ?? undefined,
                supersedenceTracking: pending.policy.supersedenceTracking ?? undefined
            }),
            intent: 'enqueue',
            phase: 'immediate',
            origin: 'drain',
            options: { pendingAdmission: effect.entry }
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

    async writePreparedMessage(
        payload: Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'send-prepared'; }>,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle,
        attempts: number
    ): Promise<ALWorkAttemptResult> {
        const runtime = this.dependencies.runtime;
        if (await runtime.admissionStore.isMessageSuperseded(lifecycle.canonicalMessage)) {
            return { status: 'completed' };
        }
        const receipts = await runtime.admissionStore.readReceiptState(payload.message.msgId);
        if (receipts && isALOutboundReceiptComplete(receipts)) {
            return { status: 'completed' };
        }
        if (
            (lifecycle.expiresAtMs !== undefined && lifecycle.expiresAtMs <= this.readNowMs()) ||
            lifecycle.signal.aborted
        ) {
            return { status: 'completed' };
        }
        const retry = retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, attempts, runtime.random());
        const sendResult = await runtime.sendPreparedMessage(payload.prepared, payload.phase, lifecycle);
        const timing = {
            observedAtMs: this.readNowMs(),
            retryDelayMs: retry.delayMs ?? 0,
            expiresAtMs: lifecycle.expiresAtMs
        };
        if (sendResult.status === 'queued') {
            return {
                status: 'retained',
                settled: sendResult.settled.then((settled) =>
                    computeALOutboundSendDisposition(settled, { ...timing, observedAtMs: this.readNowMs() })
                )
            };
        }
        return computeALOutboundSendDisposition(sendResult, timing);
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

function computeALOutboundSendDisposition(
    result: ALOutboundSettledSendResult,
    timing: ALOutboundSettlementTiming
): ALWorkOutcome {
    if (timing.expiresAtMs !== undefined && timing.observedAtMs >= timing.expiresAtMs) {
        return { status: 'completed' };
    }
    if (result.status !== 'not-ready' && result.status !== 'failed') {
        return { status: 'completed' };
    }
    if (result.status === 'failed') {
        return { status: 'retry' };
    }
    const retryAtMs = timing.observedAtMs + Math.max(1, result.retryAfterMs ?? timing.retryDelayMs);
    return {
        status: 'not-ready',
        readyAtMs: timing.expiresAtMs === undefined ? retryAtMs : Math.min(retryAtMs, timing.expiresAtMs)
    };
}
