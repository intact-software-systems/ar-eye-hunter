import type { ALOutboundFirstHopTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    computeALOutboundFirstHopTimeout,
    type ALOutboundFirstHopWaitSnapshot
} from '@shared/alm/outbound/first-hop/compute-al-outbound-first-hop-wait.ts';

/** A publisher's wait for its server to first answer for a send, as the product's WS client holds it. */
export interface OrderedSendFirstHopWait {
    /** The product's own record of the wait: its timeout, its retries, how many it has spent, and its deadline. */
    readonly snapshot: ALOutboundFirstHopWaitSnapshot;
    /** When the send's lifetime ends, on the clock of the deadline. */
    readonly messageExpiresAtMs: number;
}

export interface CreateOrderedSendFirstHopWaitInput {
    readonly msgId: string;
    /** The wait the product's WS client plans for the send. */
    readonly tracking: ALOutboundFirstHopTrackingPlan;
    /** The instant the send's first frame was offered at. */
    readonly offeredAtMs: number;
    readonly messageExpiresAtMs: number;
}

/** What a wait does at one instant: nothing yet, or a resend, each with the wait it then holds, or its end. */
export type OrderedSendFirstHopTurn =
    | { readonly kind: 'waiting' | 'resend'; readonly wait: OrderedSendFirstHopWait; }
    | { readonly kind: 'ended'; };

/**
 * The wait the product's client records with the dispatch that writes a send's first frame
 * (`computeALOutboundFirstHopWaitWrites`): no retry spent, and a deadline one timeout after the frame. The first
 * frame is no attempt of the product's, so the wait names it by its message.
 */
export function createOrderedSendFirstHopWait(input: CreateOrderedSendFirstHopWaitInput): OrderedSendFirstHopWait {
    const { timeoutMs, maxAttempts } = input.tracking;
    return {
        snapshot: {
            msgId: input.msgId,
            timeoutMs,
            maxAttempts,
            attempts: 0,
            deadlineAtMs: input.offeredAtMs + timeoutMs,
            attemptIdentity: `first-frame:${input.msgId}`,
            phase: 'immediate'
        },
        messageExpiresAtMs: input.messageExpiresAtMs
    };
}

/**
 * What the wait does at `nowMs`, by the product's own `computeALOutboundFirstHopTimeout`: before its deadline
 * nothing; at it, while a retry is left and the message lives, a resend and a deadline one timeout after `nowMs`;
 * with its retries spent or its message's lifetime over, its end. A frame here leaves the moment it is offered, so
 * none is ever held, and no re-plan is refused. The product then ends the message as `receipt-exhausted`; a
 * publisher of the cell only stops resending it.
 */
export function computeOrderedSendFirstHopTurn(wait: OrderedSendFirstHopWait, nowMs: number): OrderedSendFirstHopTurn {
    const decision = computeALOutboundFirstHopTimeout({
        wait: wait.snapshot,
        messageLive: wait.messageExpiresAtMs > nowMs,
        attemptHeld: false,
        replanRefusal: undefined,
        nowMs
    });
    switch (decision.kind) {
        case 'early':
            return { kind: 'waiting', wait };
        case 'unwritten':
            return { kind: 'waiting', wait: { ...wait, snapshot: decision.next } };
        case 'resend':
            return { kind: 'resend', wait: { ...wait, snapshot: decision.next } };
        case 'ended':
        case 'orphaned':
        case 'exhausted':
        case 'refused':
            return { kind: 'ended' };
    }
}
