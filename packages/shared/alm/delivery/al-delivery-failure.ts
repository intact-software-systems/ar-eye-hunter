import type { ALNackReason } from '../../al-contracts/al-control.ts';
import type {
    ALDeliveryAttemptOutcome,
    ALDeliveryRefusalReason,
    ALDeliveryRelayRejection,
    ALDeliverySkippedReason,
    ALDeliveryUnroutableReason
} from './al-delivery-lifecycle.ts';

export type ALDeliveryReceiptExhaustion =
    | Readonly<{ cause: 'budget'; }>
    | Readonly<{ cause: 'hop-refused'; hopPeerId: string; nackReason: ALNackReason; }>;

export type ALDeliveryReceiptExhaustedCause = ALDeliveryReceiptExhaustion['cause'];

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
