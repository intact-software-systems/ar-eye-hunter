/** What falls due at an instant of the clock its offers are timed on. */
export interface OrderedSendDue {
    readonly dueAtMs: number;
}

export interface OfferOrderedSendsWhenDueInput<DueSend extends OrderedSendDue> {
    /** In the order the sends fall due; each `dueAtMs` is an instant of the clock `nowMs` reads. */
    readonly sends: readonly DueSend[];
    readonly nowMs: () => number;
    readonly sleep: (delayMs: number) => Promise<void>;
    /** Starts the send and returns at once: its answer is never waited for, so the next send stays due on time. */
    readonly offer: (send: DueSend) => void;
}

/**
 * Offers each send open-loop, at its due instant or as soon after it as the event loop allows, and never earlier:
 * a wait that ends before the instant is waited out. Each wait is armed against the send's own due instant, never
 * against the offer before it, so a late offer is followed by the next one at that one's own time.
 */
export async function offerOrderedSendsWhenDue<DueSend extends OrderedSendDue>(
    input: OfferOrderedSendsWhenDueInput<DueSend>
): Promise<void> {
    for (const send of input.sends) {
        let remainingMs = send.dueAtMs - input.nowMs();
        while (remainingMs > 0) {
            await input.sleep(remainingMs);
            remainingMs = send.dueAtMs - input.nowMs();
        }
        input.offer(send);
    }
}
