import type {
    OrderedSendCellAck,
    OrderedSendCellAckOffer,
    OrderedSendCellOffer,
    OrderedSendCellResend,
    OrderedSendCellResendOffer,
    OrderedSendCellSend
} from './ordered-send-cell-observations.ts';
import type { OrderedSendCellEntryAnswer } from './to-ordered-send-cell-answer.ts';

/** Everything a run offered, each offer with what came of it or as unanswered, in the order offered. */
export interface OrderedSendOffersClosed {
    readonly sends: readonly OrderedSendCellSend[];
    readonly resends: readonly OrderedSendCellResend[];
    readonly acks: readonly OrderedSendCellAck[];
}

const UNANSWERED = { acceptance: 'unanswered', answeredAtMs: null } as const;

/**
 * The sends of one run as they were first offered, every later offer of one, every ACK a recipient offered, and what
 * came of each offer: the entry's answer, or that the offer threw. It takes answers until it is closed, and an offer
 * unanswered then stays unanswered.
 */
export class OrderedSendOfferLedger {
    private readonly offers: OrderedSendCellOffer[] = [];
    private readonly answers = new Map<string, OrderedSendCellEntryAnswer>();
    private readonly resendOffers: OrderedSendCellResendOffer[] = [];
    private readonly resendAnswers = new Map<number, OrderedSendCellEntryAnswer>();
    private readonly ackOffers: OrderedSendCellAckOffer[] = [];
    private readonly ackAnswers = new Map<number, OrderedSendCellEntryAnswer>();
    private closed = false;

    /** The first offer of a send. */
    recordOffer(offer: OrderedSendCellOffer): void {
        this.offers.push(offer);
    }

    /** What came of the first offer of the send. */
    recordAnswer(msgId: string, answer: OrderedSendCellEntryAnswer): void {
        if (!this.closed) {
            this.answers.set(msgId, answer);
        }
    }

    /** A later offer of a send. Returns its place among the resends, by which its answer is recorded. */
    recordResend(offer: OrderedSendCellResendOffer): number {
        return this.resendOffers.push(offer) - 1;
    }

    recordResendAnswer(resendPosition: number, answer: OrderedSendCellEntryAnswer): void {
        if (!this.closed) {
            this.resendAnswers.set(resendPosition, answer);
        }
    }

    /** An ACK a recipient offered. Returns its place among the ACKs, by which its answer is recorded. */
    recordAck(offer: OrderedSendCellAckOffer): number {
        return this.ackOffers.push(offer) - 1;
    }

    recordAckAnswer(ackPosition: number, answer: OrderedSendCellEntryAnswer): void {
        if (!this.closed) {
            this.ackAnswers.set(ackPosition, answer);
        }
    }

    /** The instant the last send was first offered at; undefined while none was. A later offer never moves it. */
    getLastOfferAtMs(): number | undefined {
        return this.offers.at(-1)?.sentAtMs;
    }

    /** Stops taking answers, and returns every offer with what came of it, or as unanswered. */
    close(): OrderedSendOffersClosed {
        this.closed = true;
        return {
            sends: this.offers.map((offer): OrderedSendCellSend => ({
                ...offer,
                ...(this.answers.get(offer.msgId) ?? UNANSWERED)
            })),
            resends: this.resendOffers.map((offer, resendPosition): OrderedSendCellResend => ({
                ...offer,
                ...(this.resendAnswers.get(resendPosition) ?? UNANSWERED)
            })),
            acks: this.ackOffers.map((offer, ackPosition): OrderedSendCellAck => ({
                ...offer,
                ...(this.ackAnswers.get(ackPosition) ?? UNANSWERED)
            }))
        };
    }
}
