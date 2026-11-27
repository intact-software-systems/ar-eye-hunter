import type { RoomSendCellEntryAnswer } from './answer/to-room-send-cell-answer.ts';
import type {
    RoomSendCellAck,
    RoomSendCellAckOffer,
    RoomSendCellOffer,
    RoomSendCellResend,
    RoomSendCellResendOffer,
    RoomSendCellSend
} from './room-send-cell-observations.ts';

/** Everything a run offered, each offer with what came of it or as unanswered, in the order offered. */
export interface RoomSendOffersClosed {
    readonly sends: readonly RoomSendCellSend[];
    readonly resends: readonly RoomSendCellResend[];
    readonly acks: readonly RoomSendCellAck[];
}

const UNANSWERED = { acceptance: 'unanswered', answeredAtMs: null } as const;

/**
 * The sends of one run as they were first offered, every later offer of one, every ACK a recipient offered, and what
 * came of each offer: the entry's answer, or that the offer threw. It takes answers until it is closed, and an offer
 * unanswered then stays unanswered.
 */
export class RoomSendOfferLedger {
    private readonly offers: RoomSendCellOffer[] = [];
    private readonly answers = new Map<string, RoomSendCellEntryAnswer>();
    private readonly resendOffers: RoomSendCellResendOffer[] = [];
    private readonly resendAnswers = new Map<number, RoomSendCellEntryAnswer>();
    private readonly ackOffers: RoomSendCellAckOffer[] = [];
    private readonly ackAnswers = new Map<number, RoomSendCellEntryAnswer>();
    private closed = false;

    /** The first offer of a send. */
    recordOffer(offer: RoomSendCellOffer): void {
        this.offers.push(offer);
    }

    /** What came of the first offer of the send. */
    recordAnswer(msgId: string, answer: RoomSendCellEntryAnswer): void {
        if (!this.closed) {
            this.answers.set(msgId, answer);
        }
    }

    /** A later offer of a send. Returns its place among the resends, by which its answer is recorded. */
    recordResend(offer: RoomSendCellResendOffer): number {
        return this.resendOffers.push(offer) - 1;
    }

    recordResendAnswer(resendPosition: number, answer: RoomSendCellEntryAnswer): void {
        if (!this.closed) {
            this.resendAnswers.set(resendPosition, answer);
        }
    }

    /** An ACK a recipient offered. Returns its place among the ACKs, by which its answer is recorded. */
    recordAck(offer: RoomSendCellAckOffer): number {
        return this.ackOffers.push(offer) - 1;
    }

    recordAckAnswer(ackPosition: number, answer: RoomSendCellEntryAnswer): void {
        if (!this.closed) {
            this.ackAnswers.set(ackPosition, answer);
        }
    }

    /** The instant the last send was first offered at; undefined while none was. A later offer never moves it. */
    getLastOfferAtMs(): number | undefined {
        return this.offers.at(-1)?.sentAtMs;
    }

    /** Stops taking answers, and returns every offer with what came of it, or as unanswered. */
    close(): RoomSendOffersClosed {
        this.closed = true;
        return {
            sends: this.offers.map((offer): RoomSendCellSend => ({
                ...offer,
                ...(this.answers.get(offer.msgId) ?? UNANSWERED)
            })),
            resends: this.resendOffers.map((offer, resendPosition): RoomSendCellResend => ({
                ...offer,
                ...(this.resendAnswers.get(resendPosition) ?? UNANSWERED)
            })),
            acks: this.ackOffers.map((offer, ackPosition): RoomSendCellAck => ({
                ...offer,
                ...(this.ackAnswers.get(ackPosition) ?? UNANSWERED)
            }))
        };
    }
}
