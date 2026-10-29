import type { ALNackReason } from '../../al-contracts/al-control.ts';
import type { ALPublicationStageLimit } from '../../al-contracts/publication/al-publication-stage-limits.ts';
import type { ALStorageUnavailableCause } from '../storage/al-storage-unavailable.ts';
import type { ALVolatileSessionLimit } from '../volatile-budget/al-volatile-session-budget.ts';
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
    /**
     * `limit` names the session volatile bound (D179) or the publication stage limit (D477) a `capacity` refusal
     * passed; absent on every other refusal.
     */
    | Readonly<
        { kind: 'refused'; reason: ALDeliveryRefusalReason; limit?: ALVolatileSessionLimit | ALPublicationStageLimit; }
    >
    | Readonly<{ kind: 'relay-rejected'; rejection: ALDeliveryRelayRejection; }>
    | Readonly<{ kind: 'admission-failed'; }>
    | Readonly<{ kind: 'storage-unavailable'; cause: ALStorageUnavailableCause; }>
    | Readonly<{ kind: 'skipped'; reason: ALDeliverySkippedReason; }>
    | Readonly<{ kind: 'unroutable'; reason: ALDeliveryUnroutableReason; }>
    | Readonly<{
        kind: 'attempt-failed';
        outcome: Extract<ALDeliveryAttemptOutcome, 'failed' | 'no-targets'>;
    }>
    | (Readonly<{ kind: 'receipt-exhausted'; }> & ALDeliveryReceiptExhaustion)
    | Readonly<{ kind: 'expired'; }>;
