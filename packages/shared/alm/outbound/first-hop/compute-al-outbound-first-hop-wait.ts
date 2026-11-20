import type { ALOutboundDurableEffectWrite } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchPhase, ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import { computeALOutboundAttemptDeadline } from '../attempt-deadline/compute-al-outbound-attempt-deadline.ts';
import type { ALOutboundDispatchWrites, ComputeALOutboundDispatchInput } from '../compute-al-outbound-dispatch.ts';
import {
    toALOutboundAttemptIdentity,
    toALOutboundEffectId,
    toALOutboundFirstHopTimeoutEffectId
} from '../to-al-outbound-effect-id.ts';

/** The sender's wait for its own hop to answer for a send; `attemptIdentity` and `phase` name the attempt whose frame it stands on. */
export interface ALOutboundFirstHopWaitSnapshot {
    readonly msgId: string;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly attempts: number;
    readonly deadlineAtMs: number;
    readonly attemptIdentity: string;
    readonly phase: ALOutboundDispatchPhase;
}

export type ALOutboundFirstHopTimeoutDecision =
    | Readonly<{ kind: 'ended' | 'orphaned' | 'early' | 'exhausted'; }>
    | Readonly<{ kind: 'refused'; refusal: ALOutboundSettlementFact; }>
    | Readonly<{ kind: 'unwritten' | 'resend'; next: ALOutboundFirstHopWaitSnapshot; }>;

export interface ComputeALOutboundFirstHopTimeoutInput {
    readonly wait: ALOutboundFirstHopWaitSnapshot | undefined;
    /** The message is still retained, re-planned and before its deadline. */
    readonly messageLive: boolean;
    /**
     * The attempt the wait stands on is planned with at least one copy, and every copy is still queued for its
     * carrier.
     */
    readonly attemptHeld: boolean;
    /** The settlement a re-plan the carrier refuses for good states; undefined when the re-plan may still send. */
    readonly replanRefusal: ALOutboundSettlementFact | undefined;
    readonly nowMs: number;
}

/**
 * The wait the dispatch that writes a send's first frame records: nothing for a repair, which never starts one, nor
 * for a send whose own hop has already answered (a receipt row) or that already waits.
 */
export function computeALOutboundFirstHopWaitWrites<TPrepared>(
    input: ComputeALOutboundDispatchInput<TPrepared>,
    messageExpiresAtMs: number
): ALOutboundDispatchWrites<TPrepared> {
    const { read } = input;
    const tracking = read.plan.firstHopTracking;
    if (
        tracking === undefined || read.plan.preparedMessages.length === 0 || input.intent === 'repair' ||
        read.pendingAck !== undefined || read.firstHopWait !== undefined
    ) {
        return { mutations: [], durableEffects: [] };
    }
    const snapshot: ALOutboundFirstHopWaitSnapshot = {
        msgId: read.msg.id.msgId,
        timeoutMs: tracking.timeoutMs,
        maxAttempts: tracking.maxAttempts,
        attempts: 0,
        deadlineAtMs: read.nowMs + tracking.timeoutMs,
        attemptIdentity: toALOutboundAttemptIdentity(input.options),
        phase: input.phase
    };
    return {
        mutations: [{ kind: 'set-first-hop-wait', snapshot, expireAtTimestamp: messageExpiresAtMs }],
        durableEffects: [toALOutboundFirstHopTimeoutEffect(snapshot, messageExpiresAtMs)]
    };
}

/**
 * What a first-hop deadline does. A re-plan refused for good ends the wait with that refusal, as it ends a receipt.
 * The rest is `computeALOutboundAttemptDeadline`'s: a frame still queued waits, and a frame that left and drew no answer
 * is written again under a new attempt identity, so a new frame goes out.
 */
export function computeALOutboundFirstHopTimeout(
    input: ComputeALOutboundFirstHopTimeoutInput
): ALOutboundFirstHopTimeoutDecision {
    const { wait, nowMs } = input;
    if (wait === undefined) {
        return { kind: 'ended' };
    }
    if (!input.messageLive) {
        return { kind: 'orphaned' };
    }
    if (wait.deadlineAtMs > nowMs) {
        return { kind: 'early' };
    }
    if (input.replanRefusal !== undefined) {
        return { kind: 'refused', refusal: input.replanRefusal };
    }
    const deadline = computeALOutboundAttemptDeadline({ budget: wait, held: input.attemptHeld, nowMs });
    switch (deadline.kind) {
        case 'exhausted':
            return { kind: 'exhausted' };
        case 'wait':
            return { kind: 'unwritten', next: { ...wait, ...deadline.next } };
        case 'retry': {
            const { attempts, deadlineAtMs } = deadline.next;
            return {
                kind: 'resend',
                next: {
                    ...wait,
                    attempts,
                    deadlineAtMs,
                    attemptIdentity: toALOutboundEffectId(['first-hop', wait.msgId, attempts, deadlineAtMs]),
                    phase: 'immediate'
                }
            };
        }
    }
}

/** The timer of a wait, retained until the message deadline as a receipt's `ack-timeout` is. */
export function toALOutboundFirstHopTimeoutEffect<TPrepared>(
    wait: ALOutboundFirstHopWaitSnapshot,
    messageExpiresAtMs: number
): ALOutboundDurableEffectWrite<TPrepared> {
    return {
        effectId: toALOutboundFirstHopTimeoutEffectId(wait),
        retryAtMs: wait.deadlineAtMs,
        expireAtTimestamp: messageExpiresAtMs,
        payload: { kind: 'first-hop-timeout', msgId: wait.msgId }
    };
}
