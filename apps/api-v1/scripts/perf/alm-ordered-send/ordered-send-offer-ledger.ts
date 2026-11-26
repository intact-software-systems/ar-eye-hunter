import type {
    OrderedSendCellOffer,
    OrderedSendCellResend,
    OrderedSendCellResendOffer,
    OrderedSendCellSend
} from './ordered-send-cell-observations.ts';
import type { OrderedSendCellEntryAnswer } from './to-ordered-send-cell-answer.ts';

/** Everything a run offered, each offer with the entry's answer or as unanswered, in the order offered. */
export interface OrderedSendOffersClosed {
    readonly sends: readonly OrderedSendCellSend[];
    readonly resends: readonly OrderedSendCellResend[];
}

/**
 * The sends of one run as they were first offered, every later offer of one, the answer the entry gave each offer,
 * and what an offer threw. It takes answers until it is closed, and an offer unanswered then stays unanswered.
 */
export class OrderedSendOfferLedger {
    private readonly offers: OrderedSendCellOffer[] = [];
    private readonly answers = new Map<string, OrderedSendCellEntryAnswer>();
    private readonly resendOffers: OrderedSendCellResendOffer[] = [];
    private readonly resendAnswers = new Map<number, OrderedSendCellEntryAnswer>();
    private readonly failures: Error[] = [];
    private closed = false;

    /** The first offer of a send. */
    recordOffer(offer: OrderedSendCellOffer): void {
        this.offers.push(offer);
    }

    /** The answer to the first offer of the send. */
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

    /** What an offer of a send or of an ACK threw. What the entry answered is an answer, never a failure. */
    recordFailure(failure: Error): void {
        this.failures.push(failure);
    }

    getFailures(): readonly Error[] {
        return this.failures;
    }

    /** The instant the last send was first offered at; undefined while none was. A later offer never moves it. */
    getLastOfferAtMs(): number | undefined {
        return this.offers.at(-1)?.sentAtMs;
    }

    /** Stops taking answers, and returns every offer with its answer, or as unanswered. */
    close(): OrderedSendOffersClosed {
        this.closed = true;
        return {
            sends: this.offers.map((offer): OrderedSendCellSend => ({
                ...offer,
                ...(this.answers.get(offer.msgId) ?? { acceptance: 'unanswered', answeredAtMs: null })
            })),
            resends: this.resendOffers.map((offer, resendPosition): OrderedSendCellResend => ({
                ...offer,
                ...(this.resendAnswers.get(resendPosition) ?? { acceptance: 'unanswered', answeredAtMs: null })
            }))
        };
    }
}
