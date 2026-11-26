import type { OrderedSendCellOffer, OrderedSendCellSend } from './ordered-send-cell-observations.ts';
import type { OrderedSendCellEntryAnswer } from './to-ordered-send-cell-answer.ts';

/**
 * The sends of one run as they were offered, the answer the entry gave each, and what an offer threw. It takes
 * answers until it is closed, and a send unanswered then stays unanswered.
 */
export class OrderedSendOfferLedger {
    private readonly offers: OrderedSendCellOffer[] = [];
    private readonly answers = new Map<string, OrderedSendCellEntryAnswer>();
    private readonly failures: Error[] = [];
    private closed = false;

    recordOffer(offer: OrderedSendCellOffer): void {
        this.offers.push(offer);
    }

    recordAnswer(msgId: string, answer: OrderedSendCellEntryAnswer): void {
        if (!this.closed) {
            this.answers.set(msgId, answer);
        }
    }

    /** What an offer of a send or of an ACK threw. What the entry answered is an answer, never a failure. */
    recordFailure(failure: Error): void {
        this.failures.push(failure);
    }

    getFailures(): readonly Error[] {
        return this.failures;
    }

    /** The instant the last send was offered at; undefined while none was. */
    getLastOfferAtMs(): number | undefined {
        return this.offers.at(-1)?.sentAtMs;
    }

    /** Stops taking answers, and returns every send with its answer, or as unanswered, in the order offered. */
    close(): readonly OrderedSendCellSend[] {
        this.closed = true;
        return this.offers.map((offer): OrderedSendCellSend => ({
            ...offer,
            ...(this.answers.get(offer.msgId) ?? { acceptance: 'unanswered', answeredAtMs: null })
        }));
    }
}
