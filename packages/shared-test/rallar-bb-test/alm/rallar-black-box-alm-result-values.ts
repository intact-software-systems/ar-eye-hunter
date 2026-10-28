import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryAttemptOutcome,
    ALDeliveryCarrier,
    ALDeliveryEvidence,
    ALDeliveryReceiptEvidence,
    ALDeliveryRefusalReason,
    ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { RallarBlackBoxTestMessagesCarrier } from '../rallar-black-box-test-contracts.ts';

export interface RallarBlackBoxTestMessagesSendResultValue {
    readonly handleId: string;
    readonly msgId?: string;
    readonly carrier: RallarBlackBoxTestMessagesCarrier;
    readonly status: ALDeliveryState;
    readonly reason?: string;
    readonly traceId: string;
    readonly corrId: string;
}

/** A replay opens no handle of its own: it reports the replayed handle and the verdict of the carrier admission. */
export interface RallarBlackBoxTestMessagesReplayResultValue {
    readonly handleId: string;
    readonly msgId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly verdict: ALDeliveryAdmissionVerdict['kind'];
    /** The detail of the verdict itself; absent for `admitted`, `duplicate` and `pending`, which carry none. */
    readonly reason?: string;
}

/** A raw control opens no handle: it reports its own identity and the verdict of the carrier admission. */
export interface RallarBlackBoxTestMessagesControlResultValue {
    readonly msgId: string;
    readonly typeId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly verdict: ALDeliveryAdmissionVerdict['kind'];
    /**
     * The detail of the verdict itself, absent for `admitted`, `duplicate` and `pending`, which carry none; or the
     * harness's own `acked-message-unknown`, on a refusal before any admission.
     */
    readonly reason?: string;
    /**
     * The trace the control envelope carried, that of the acknowledged message. Absent only on the harness's
     * `refused` / `acked-message-unknown` result, which admitted nothing; the decoder requires it on every other verdict.
     */
    readonly traceId?: string;
}

export interface RallarBlackBoxTestMessagesObserveResultValue
    extends
        ALDeliveryReceiptEvidence,
        Pick<ALDeliveryEvidence, 'relayRejection' | 'failure' | 'carrierFallback' | 'durabilityDowngrade'> {
    readonly handleId: string;
    readonly state: ALDeliveryState;
    readonly submitted: boolean;
    readonly enqueued: boolean;
    readonly attempts: number;
    readonly attemptOutcomes: readonly ALDeliveryAttemptOutcome[];
    /** The carrier of every settled attempt, index-aligned with `attemptOutcomes`: a hand-over reads `rtc` then `ws` (D56). */
    readonly attemptCarriers: readonly ALDeliveryCarrier[];
    /** The reason of every refused admission row, in attempt order: a leg the fallback carrier took over. */
    readonly attemptRefusalReasons: readonly ALDeliveryRefusalReason[];
    readonly reason: string | undefined;
}

/** Payload-free: the request's correlation and lifecycle, and for `replied` the reply's identity. */
export type RallarBlackBoxTestMessagesAwaitReplyResultValue =
    | Readonly<{
        handleId: string;
        status: 'replied';
        state: ALDeliveryState;
        corrId: string;
        reply: Readonly<
            { msgId: string; replyToMsgId: string; corrId: string; senderId: string; typeId: string; traceId: string; }
        >;
    }>
    | Readonly<
        { handleId: string; status: 'timeout' | 'aborted' | 'undelivered'; state: ALDeliveryState; corrId: string; }
    >;

/** The reply's own handle and identity; its payload stays in the page. */
export interface RallarBlackBoxTestMessagesReplyResultValue {
    readonly handleId: string;
    readonly msgId: string;
    readonly replyToMsgId: string;
    readonly traceId: string;
    readonly corrId: string;
}

export interface RallarBlackBoxTestStorageCountersResultValue {
    readonly total: number;
    readonly byOwner: Readonly<Record<'al-admission' | 'al-work', number>>;
    readonly byKind: Readonly<Record<string, number>>;
    /** The durable owners' idle probes: `work-page` and `work-probe` (D55 reports them beside the zero). */
    readonly workProbeCount: number;
    /** Every `al-work` operation but the probes. */
    readonly workNonProbeCount: number;
    /** Whether this reading reset the counter after reading it, so the next reading counts from zero. */
    readonly reset: boolean;
}
