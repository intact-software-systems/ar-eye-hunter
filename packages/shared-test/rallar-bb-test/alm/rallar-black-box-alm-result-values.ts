import type { RallarTopicSubscriptionStatus } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALDeliveryCarrier } from '@shared/al-contracts/al-control-value-codec.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryAttemptOutcome,
    ALDeliveryEvidence,
    ALDeliveryReceiptEvidence,
    ALDeliveryRefusalReason,
    ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import type { BoundedHistogram } from '@shared/measurement/bounded-histogram.ts';
import type { TransportFaultActedCounts } from '@shared/transport-faults/to-transport-fault-acted-counts.ts';

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

/** A send that observes `call-refused` and was refused at the call opens no handle: it reports the refusal's issues. */
export interface RallarBlackBoxTestMessagesCallRefusalResultValue {
    readonly handleId: string;
    readonly carrier: RallarBlackBoxTestMessagesCarrier;
    /** Every issue of the product's validation refusal, in the product's order, without its message text. */
    readonly callRefusal: readonly Pick<RallarValidationIssue, 'path' | 'code'>[];
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
    | Readonly<{
        handleId: string;
        status: 'timeout' | 'aborted' | 'undelivered' | 'unanswerable';
        state: ALDeliveryState;
        corrId: string;
    }>;

/** The reply's own handle and identity; its payload stays in the page. */
export interface RallarBlackBoxTestMessagesReplyResultValue {
    readonly handleId: string;
    readonly msgId: string;
    readonly replyToMsgId: string;
    readonly traceId: string;
    readonly corrId: string;
}

/** One matched inbound copy, read from its typed-channel event `data`. */
export interface AlmReceivedMessageIdentity {
    readonly msgId: string;
    readonly traceId: string;
    readonly corrId: string;
    readonly transport: ALDeliveryCarrier;
}

export interface RallarBlackBoxTestMessagesReceivedResultValue {
    readonly typeId: string;
    /** Absent when the count names no single message. */
    readonly msgId?: string;
    readonly count: number;
    readonly observed: number;
    readonly absent: boolean;
    /**
     * Present only when the command named `ascendingBy`: whether that payload field is a number in every matched
     * copy and strictly ascends in arrival order.
     */
    readonly ascending?: boolean;
    /** Present only when the command named `stallMs`: that window, and whether it ended the count before its window. */
    readonly stall?: AlmReceivedStall;
    /**
     * Present only when the command named `ageFrom`: absence says no age was asked for, which an empty histogram
     * would not, so this field stays optional.
     */
    readonly sampleAge?: AlmReceivedSampleAge;
    /** Every matched copy in arrival order. */
    readonly received: readonly AlmReceivedMessageIdentity[];
}

export interface AlmReceivedStall {
    readonly stallMs: number;
    readonly stalled: boolean;
}

/**
 * One sample per matched copy: the agent's clock when its event log recorded the copy, less the number the copy's
 * payload holds at `from`. `ageMs.count + unrecordedSamples` is the number of matched copies.
 */
export interface AlmReceivedSampleAge {
    /** The payload field the command named as `ageFrom`. */
    readonly from: string;
    /** On `AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS`, so it compares bucket by bucket with the publication stage's ages. */
    readonly ageMs: BoundedHistogram;
    /** Copies with no finite number at `from`, or stamped after they arrived; none is clamped into `ageMs`. */
    readonly unrecordedSamples: number;
}

/**
 * `acted` is what the fault of this `faultId` has acted on so far, read after this injection: a release
 * (`remaining: 0`) therefore reads the fault's totals. Present for a transport fault only.
 */
export interface RallarBlackBoxTestFaultInjectResultValue {
    readonly faultId: string;
    readonly injected: true;
    readonly acted?: TransportFaultActedCounts;
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

/** One token the page holds under the recipe's `subscriptionId`, read with its status as the product reports it. */
export interface RallarBlackBoxTestMessagesSubscribeResultValue {
    readonly subscriptionId: string;
    readonly status: RallarTopicSubscriptionStatus;
}

export interface AlmTopicSubscriptionEntry extends RallarBlackBoxTestMessagesSubscribeResultValue {
    readonly topicId: string;
}

export interface RallarBlackBoxTestMessagesSubscriptionsResultValue {
    /** The open product socket's connection generation; null while the socket is closed or its generation unread. */
    readonly connectionGenerationId: string | null;
    readonly subscriptions: readonly AlmTopicSubscriptionEntry[];
}
