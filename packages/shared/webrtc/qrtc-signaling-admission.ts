import type { ALDeliveryAdmissionVerdict } from '../alm/delivery/al-delivery-lifecycle.ts';

/**
 * Where an outbound signal was lost: the transport's own terminal verdict on the message, or a hop
 * that failed before admission ever saw one.
 */
export type QRtcSignalingAdmission =
    | Readonly<{
        outcome: 'rejected';
        verdict: ALDeliveryAdmissionVerdict;
        messageId: string;
    }>
    | Readonly<{ outcome: 'never-admitted'; }>;

/**
 * A signal admission refused. The awaiting hop still unwinds -- an offer that never left leaves the
 * peer in `have-local-offer` -- but the verdict travels with the throw instead of being reduced to a
 * message, so the peer can name the verdict and the message it lost.
 */
export class QRtcSignalingAdmissionError extends Error {
    public readonly admission: QRtcSignalingAdmission;

    constructor(verdict: ALDeliveryAdmissionVerdict, messageId: string, reason: string) {
        super(reason);
        this.name = 'QRtcSignalingAdmissionError';
        this.admission = { outcome: 'rejected', verdict, messageId };
    }
}

/** The verdict a failed hop carries, or `never-admitted` when the failure preceded admission. */
export function toQRtcSignalingAdmission(error: Error): QRtcSignalingAdmission {
    return error instanceof QRtcSignalingAdmissionError
        ? error.admission
        : { outcome: 'never-admitted' };
}
