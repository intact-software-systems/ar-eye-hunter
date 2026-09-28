import type { ALNackReason } from '../../al-contracts/al-control.ts';
import type {
    ALDeliveryAttemptOutcome,
    ALDeliveryRefusalReason,
    ALDeliveryRelayRejection,
    ALDeliverySkippedReason,
    ALDeliveryUnroutableReason
} from './al-delivery-lifecycle.ts';

/** Why a receipt ended before every expected peer confirmed. */
export type ALDeliveryReceiptExhaustedCause = 'budget' | 'hop-refused';

/**
 * A receipt's end as its producer states it: the retry budget ran out, or a hop the receipt tracks refused the
 * message for good with a terminal NACK, named with its reason.
 */
export type ALDeliveryReceiptExhaustion =
    | Readonly<{ cause: 'budget'; }>
    | Readonly<{ cause: 'hop-refused'; hopPeerId: string; nackReason: ALNackReason; }>;

/**
 * Why a send ended `rejected`, `failed` or `expired`; `evidence.reason` keeps the prose. A refusal ends `rejected`,
 * the deadline `expired`, every other kind `failed`.
 */
export type ALDeliveryFailure =
    | Readonly<{ kind: 'refused'; reason: ALDeliveryRefusalReason; }>
    | Readonly<{ kind: 'relay-rejected'; rejection: ALDeliveryRelayRejection; }>
    | Readonly<{ kind: 'admission-failed'; }>
    | Readonly<{ kind: 'skipped'; reason: ALDeliverySkippedReason; }>
    | Readonly<{ kind: 'unroutable'; reason: ALDeliveryUnroutableReason; }>
    | Readonly<{
        kind: 'attempt-failed';
        outcome: Extract<ALDeliveryAttemptOutcome, 'failed' | 'no-targets'>;
    }>
    | (Readonly<{ kind: 'receipt-exhausted'; }> & ALDeliveryReceiptExhaustion)
    | Readonly<{ kind: 'expired'; }>;
