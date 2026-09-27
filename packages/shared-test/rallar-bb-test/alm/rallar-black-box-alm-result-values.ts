import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryAttemptOutcome,
    ALDeliveryCarrier,
    ALDeliveryEvidence,
    ALDeliveryReceiptEvidence,
    ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { RallarBlackBoxTestMessagesCarrier } from '../rallar-black-box-test-contracts.ts';

export interface RallarBlackBoxTestMessagesSendResultValue {
    readonly handleId: string;
    readonly msgId?: string;
    readonly carrier: RallarBlackBoxTestMessagesCarrier;
    readonly status: ALDeliveryState;
    readonly reason?: string;
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
    /** The detail of the verdict itself; absent for `admitted`, `duplicate` and `pending`, which carry none. */
    readonly reason?: string;
}

export interface RallarBlackBoxTestMessagesObserveResultValue
    extends ALDeliveryReceiptEvidence, Pick<ALDeliveryEvidence, 'relayRejection'> {
    readonly handleId: string;
    readonly state: ALDeliveryState;
    readonly submitted: boolean;
    readonly enqueued: boolean;
    readonly attempts: number;
    readonly attemptOutcomes: readonly ALDeliveryAttemptOutcome[];
    readonly reason: string | undefined;
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
